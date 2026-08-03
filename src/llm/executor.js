import config from "../config.js";
import { applyRule } from "../bdi/rules.js";

const dbg = (...args) => {
    if (config.debug) console.log("[llm]", ...args);
};

/**
 * @typedef {Object} ToolExecutionResult
 * @property {boolean} ok
 * @property {string} observation
 * @property {string | null} replanReason
 */

/** @param {string} observation @returns {ToolExecutionResult} */
function success(observation) {
    if (typeof observation !== "string") {
        throw new TypeError("a successful tool result needs a string observation");
    }
    const text = observation.trim();
    if (!text) throw new TypeError("a successful tool result needs an observation");
    return { ok: true, observation: text, replanReason: null };
}

/**
 * @param {string} observation
 * @param {string} replanReason
 * @returns {ToolExecutionResult}
 */
function failure(observation, replanReason) {
    if (typeof observation !== "string" || typeof replanReason !== "string") {
        throw new TypeError("a failed tool result needs string fields");
    }
    const text = observation.trim();
    const reason = replanReason.trim();
    if (!text || !reason) {
        throw new TypeError("a failed tool result needs an observation and a replan reason");
    }
    return { ok: false, observation: text, replanReason: reason };
}

/** Only digits, spaces, parentheses and the four operators are ever parsed. */
const ARITHMETIC = /^[\d+\-*/()\s]+$/;

/**
 * Evaluates an arithmetic expression without eval, which would run whatever
 * the sender wrote inside our process. Anything outside plain arithmetic is
 * rejected before parsing, and the parser itself only knows numbers.
 * @param {string} expression
 * @returns {number | null} the value, or null when the input is not arithmetic
 */
export function evaluateExpression(expression) {
    if (typeof expression !== "string" || !ARITHMETIC.test(expression)) return null;

    const tokens = expression.match(/\d+|[+\-*/()]/g) ?? [];
    let next = 0;

    const readSum = () => {
        let value = readProduct();
        while (tokens[next] === "+" || tokens[next] === "-") {
            value = tokens[next++] === "+" ? value + readProduct() : value - readProduct();
        }
        return value;
    };
    const readProduct = () => {
        let value = readValue();
        while (tokens[next] === "*" || tokens[next] === "/") {
            value = tokens[next++] === "*" ? value * readValue() : value / readValue();
        }
        return value;
    };
    const readValue = () => {
        if (tokens[next] === "-") {
            next += 1;
            return -readValue();
        }
        if (tokens[next] === "(") {
            next += 1;
            const value = readSum();
            if (tokens[next++] !== ")") throw new Error("unbalanced parentheses");
            return value;
        }
        const token = tokens[next++];
        if (!/^\d+$/.test(token ?? "")) throw new Error("expected a number");
        return Number(token);
    };

    try {
        const value = readSum();
        if (next !== tokens.length) return null;
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Reads a tile out of what the model wrote, accepting the shapes it tends to
 * produce for a pair of coordinates.
 * @param {string} input
 * @returns {{x: number, y: number} | null}
 */
function parseTile(input) {
    const numbers = String(input ?? "").match(/-?\d+/g);
    if (!numbers || numbers.length < 2) return null;
    return { x: Number(numbers[0]), y: Number(numbers[1]) };
}

/**
 * Reads a tile and a duration, the input both waiting tools take.
 * @param {string} input
 * @returns {{x: number, y: number, seconds: number} | null}
 */
function parseHold(input) {
    const numbers = String(input ?? "").match(/-?\d+/g);
    if (!numbers || numbers.length < 3) return null;
    const hold = {
        x: Number(numbers[0]),
        y: Number(numbers[1]),
        seconds: Number(numbers[2])
    };
    return hold.seconds > 0 ? hold : null;
}

/**
 * The tools the model can call, and the only place they are described.
 * The system prompt is generated from this registry, so a new tool becomes
 * available to the model as soon as it is added here.
 * Every tool returns a structured result. The model sees the observation,
 * while a semantic failure also gives the planner one clear replan reason.
 */
export class LLMExecutor {
    /**
     * @param {{beliefs: import("../bdi/beliefs.js").Beliefs,
     *          socket: object,
     *          objectives: import("../bdi/objectives.js").ObjectiveStore}} parts
     */
    constructor({ beliefs, socket, objectives }) {
        this.beliefs = beliefs;
        this.socket = socket;
        this.objectives = objectives;

        this.tools = {
            go_to: {
                description: "Walk to a tile. Input is the pair of coordinates, "
                    + "for example 4,7. Returns when you arrive or when the tile "
                    + "cannot be reached.",
                run: input => this.goTo(input),
            },
            pick_up: {
                description: "Pick up the parcels lying on the tile you are "
                    + "standing on. Walk there first.",
                run: () => this.pickUp(),
            },
            put_down: {
                description: "Drop the parcels you carry on the tile you are "
                    + "standing on. On a delivery tile they are scored.",
                run: () => this.putDown(),
            },
            calculate: {
                description: "Work out an arithmetic expression, for example "
                    + "4*2+1. Use it whenever a mission gives a coordinate as a "
                    + "sum or a product instead of a number.",
                run: async input => {
                    const expression = typeof input === "string" ? input : "";
                    const value = evaluateExpression(expression);
                    return value === null
                        ? failure(
                            `Cannot compute "${expression}": only numbers, + - * / and parentheses are allowed.`,
                            "the calculation input was invalid"
                        )
                        : success(`${expression} = ${value}`);
                },
            },
            // The five tools below change normal BDI deliberation without taking it over.
            // Their rules stay in force after the mission ends.
            set_scoring_rule: {
                description: "Change how rewards are scored, for a mission that holds for the "
                    + "rest of the game. Input is one JSON object. The axes are stack_count "
                    + '(fields equals, min, max), delivery_tile (fields x, y) and '
                    + "parcel_value (fields minReward, maxReward). The effect is multiplier, "
                    + "additive, or both. Registering the same id again replaces the rule. "
                    + "Rules add up, so a mission usually needs more than one. For a mission "
                    + "that pays for a stack of a given size, register the bonus at that size "
                    + "and a reduction below it, or nothing will make you hold on to parcels "
                    + "instead of delivering them one at a time. For stacks of three: "
                    + '{"id":"stack3","axis":"stack_count","equals":3,"multiplier":2} and '
                    + '{"id":"small","axis":"stack_count","max":2,"multiplier":0.3}. '
                    + "To discourage something use a fraction, never 0: 0 means you can never "
                    + "do it at all, and parcels you cannot deliver decay in your hands.",
                run: input => this.registerRule(input),
            },
            avoid_tile: {
                description: "Never walk through a tile again, for a mission that punishes "
                    + 'stepping on one. Input is the tile, for example "4,7". The agent will '
                    + "still cross it if that is the only way to reach anything at all.",
                run: async input => {
                    const tile = parseTile(input);
                    if (!tile) {
                        return failure(
                            `Cannot read "${input}" as a tile. Write it as x,y.`,
                            "the avoid_tile input was not a valid tile"
                        );
                    }
                    this.beliefs.rules.avoidTile(tile);
                    return success(`Avoiding (${tile.x},${tile.y}) from now on.`);
                },
            },
            hold_at: {
                description: "Go to a tile and wait there, then go back to playing. Input is "
                    + 'the tile and the seconds to wait, for example "4,7 30". Use it for a '
                    + "mission that asks you to be somewhere at a time.",
                run: input => this.hold(input),
            },
            send_partner_to: {
                description: "Ask the other agent to go to a tile and wait there, while you "
                    + 'carry on. Same input as hold_at, for example "4,7 30". Use it for a '
                    + "mission that asks both agents to meet.",
                run: input => this.sendPartnerTo(input),
            },
            clear_rules: {
                description: "Lift every rule registered so far and go back to ordinary "
                    + "scoring. Takes no input. Use it when a mission is called off.",
                run: async () => {
                    const lifted = this.beliefs.rules.clear();
                    return success(lifted === 0
                        ? "there were no rules to lift"
                        : `lifted ${lifted} rules: scoring is back to normal`);
                },
            },
        };
    }

    /** @param {string} reason */
    cancelPendingObjective(reason) {
        return this.objectives.cancelActive(reason);
    }

    /**
     * Sends the final mission result to its immutable sender.
     * @param {string} senderId
     * @param {string} message
     * @returns {Promise<string>}
     */
    async replyTo(senderId, message) {
        if (typeof senderId !== "string" || !senderId.trim()) {
            throw new TypeError("mission sender must be a non-empty string");
        }
        if (typeof message !== "string" || !message.trim()) {
            throw new TypeError("mission reply must be a non-empty string");
        }

        const status = await this.socket.emitSay(senderId, message.trim());
        return `message sent (${status})`;
    }

    /**
     * Runs one known tool and checks that it returned a consistent result.
     * Unexpected errors are logged here but only a safe observation reaches the model.
     * @param {string} name
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async run(name, input) {
        const toolName = typeof name === "string" ? name.trim() : "";
        if (!toolName || !Object.hasOwn(this.tools, toolName)) {
            const shownName = toolName || "(empty)";
            return failure(
                `Unknown tool: ${shownName}. Available tools: ${Object.keys(this.tools).join(", ")}.`,
                toolName
                    ? `the selected tool "${toolName}" does not exist`
                    : "the selected tool name was invalid"
            );
        }

        const tool = this.tools[toolName];
        dbg(`${toolName}(${input ?? ""})`);
        try {
            const result = await tool.run(input);
            const validSuccess = result?.ok === true
                && result.replanReason === null;
            const validFailure = result?.ok === false
                && typeof result.replanReason === "string"
                && Boolean(result.replanReason.trim());
            if ((!validSuccess && !validFailure)
                || typeof result?.observation !== "string"
                || !result.observation.trim()) {
                throw new TypeError(`${toolName} returned an invalid tool result`);
            }
            return result;
        } catch (error) {
            console.error(`[llm] ${toolName} tool failed unexpectedly:`, error);
            return failure(
                "The tool failed because of an internal error.",
                `the ${toolName} tool failed unexpectedly`
            );
        }
    }

    /**
     * Publishes a tile objective and waits for the BDI loop to report its result.
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async goTo(input) {
        const target = parseTile(input);
        if (!target) {
            return failure(
                `Cannot read "${input}" as a tile. Write it as x,y.`,
                "the go_to input was not a valid tile"
            );
        }

        const { completion } = this.objectives.requestGoTo(target);
        const result = await completion;
        if (result.status === "succeeded") {
            return success(`Reached (${target.x},${target.y}).`);
        }
        if (result.status === "failed") {
            const reason = String(result.reason || "no path was found").trim();
            return failure(
                `Cannot reach (${target.x},${target.y}): ${reason}`,
                `the target tile (${target.x},${target.y}) could not be reached: ${reason}`
            );
        }
        if (result.status === "cancelled") {
            const reason = String(result.reason || "the objective was cancelled").trim();
            return failure(
                `Go-to (${target.x},${target.y}) was cancelled: ${reason}`,
                `the go_to objective for (${target.x},${target.y}) was cancelled: ${reason}`
            );
        }
        throw new TypeError("go_to received an unknown objective result");
    }

    /**
     * Requests one pickup and waits for the BDI loop to return the server result.
     * @returns {Promise<ToolExecutionResult>}
     */
    async pickUp() {
        const { completion } = this.objectives.requestPickup();
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        if (result.status === "failed") {
            const reason = String(result.reason || "pickup failed").trim();
            return failure(
                `Pickup failed: ${reason}`,
                reason === "no parcels were picked up"
                    ? "there were no parcels available on the current tile"
                    : `the pickup could not be completed: ${reason}`
            );
        }
        if (result.status === "cancelled") {
            const reason = String(result.reason || "the objective was cancelled").trim();
            return failure(
                `Pickup was cancelled: ${reason}`,
                `the pickup objective was cancelled: ${reason}`
            );
        }
        throw new TypeError("pick_up received an unknown objective result");
    }

    /**
     * Requests one putdown and waits for the BDI loop to return the server result.
     * @returns {Promise<ToolExecutionResult>}
     */
    async putDown() {
        const { completion } = this.objectives.requestPutdown();
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        if (result.status === "failed") {
            const reason = String(result.reason || "putdown failed").trim();
            let replanReason = `the putdown could not be completed: ${reason}`;
            if (reason === "not carrying any parcels") {
                replanReason = "the agent is not carrying any parcels to put down";
            } else if (reason === "no parcels were put down") {
                replanReason = "no parcels were put down on the current tile";
            }
            return failure(`Putdown failed: ${reason}`, replanReason);
        }
        if (result.status === "cancelled") {
            const reason = String(result.reason || "the objective was cancelled").trim();
            return failure(
                `Putdown was cancelled: ${reason}`,
                `the putdown objective was cancelled: ${reason}`
            );
        }
        throw new TypeError("put_down received an unknown objective result");
    }

    /**
     * Registers a scoring rule written by the model, and passes it to the partner.
     * A rule of the game binds the team, but the mission was only sent to one of us.
     * @param {string} input the rule as JSON
     * @returns {Promise<ToolExecutionResult>}
     */
    async registerRule(input) {
        let raw;
        try {
            raw = JSON.parse(String(input ?? ""));
        } catch {
            // A rejected tool call is a message the model can act on, so it says what a good
            // one looks like rather than only that this one was bad.
            return failure(
                'That is not JSON. Write one object, for example '
                    + '{"id":"stack3","axis":"stack_count","equals":3,"multiplier":2}.',
                "the scoring rule input was not valid JSON"
            );
        }

        const result = applyRule(this.beliefs.rules, raw);
        if (!result.ok) {
            return failure(
                `Rule refused: ${result.reason}`,
                `the scoring rule was invalid: ${result.reason}`
            );
        }

        // What goes on the wire is the rule as written, not as stored: the partner puts it
        // through the same validation this agent just did, and that reads the written shape.
        this.beliefs.partner.sendRule(raw);
        return success(`Rule ${result.rule.id} is in force: ${result.summary}`);
    }

    /**
     * Sends this agent to a tile for a while.
     * @param {string} input tile and seconds
     * @returns {Promise<ToolExecutionResult>}
     */
    async hold(input) {
        const hold = parseHold(input);
        if (!hold) {
            return failure(
                `Cannot read "${input}". Write it as x,y seconds.`,
                "the hold_at input was invalid"
            );
        }

        const result = applyRule(this.beliefs.rules, {
            id: `hold ${hold.x},${hold.y}`,
            ...hold
        });
        return result.ok
            ? success(result.summary)
            : failure(
                `Cannot hold there: ${result.reason}`,
                `the hold request was invalid: ${result.reason}`
            );
    }

    /**
     * Sends the partner to a tile for a while. The name says partner, so nothing is
     * registered here: this agent carries on with what it was doing.
     * @param {string} input tile and seconds
     * @returns {Promise<ToolExecutionResult>}
     */
    async sendPartnerTo(input) {
        const hold = parseHold(input);
        if (!hold) {
            return failure(
                `Cannot read "${input}". Write it as x,y seconds.`,
                "the send_partner_to input was invalid"
            );
        }
        if (!this.beliefs.partner.isKnown) {
            return failure(
                "There is no available partner agent to send.",
                "the partner agent is unavailable"
            );
        }

        this.beliefs.partner.sendRule({ id: `hold ${hold.x},${hold.y}`, ...hold });
        return success(`Asked the other agent to wait at (${hold.x},${hold.y}) `
            + `for ${hold.seconds} seconds.`);
    }
}

// The prompt lives next to the registry above because it is written from it.
// Apart, the two drift in silence: the model would be told about a tool that is
// gone, or never hear about one that is there.

/**
 * Builds the system prompt from the tool registry.
 * The registry is the only description of the tools, so adding one there is
 * enough for the model to learn about it: nothing has to be edited twice.
 * @param {LLMExecutor} executor
 * @returns {string}
 */
export function buildSystemPrompt(executor) {
    const tools = Object.entries(executor.tools)
        .map(([name, tool]) => `- ${name}: ${tool.description}`)
        .join("\n");

    return `You play Deliveroo, a game on a grid. You pick up parcels, carry them
to a delivery tile and put them down there to score points. Players talk to you
in the chat and may give you a mission.

The current game state is included in every turn.
Use that state directly instead of asking for it again.
The bottom-left tile is (0,0). x grows to the right and y grows upwards.
Partner information is the last state reported by the other agent. If partner
information is missing, do not invent it.

Your tools:
${tools}

Decide whether a mission is worth doing before taking action:
- a mission that awards negative points is never worth doing;
- a mission whose walk is long compared to what it pays is not worth doing
  either, because delivering ordinary parcels in that time pays more;
- when a mission is not worth it, use a brief Final Answer starting with
  "Declining:" and say why.
Missions sometimes write a coordinate as a calculation, such as x=4*2. Work it
out with calculate rather than in your head.

Answer with exactly one of these two shapes, and nothing else.

To use a tool:
Thought: <what you are doing and why>
Action: <the name of one tool>
Action Input: <its input, or nothing when it takes none>

When the goal is reached and there is nothing left to do:
Thought: <what you concluded>
Final Answer: <a short summary of what you did>

Take one step at a time. After each action you are given its result, and then
you choose the next step. Use Final Answer only when the mission is complete or
you decline it. The runtime sends that answer to the mission sender and closes
the mission automatically.`;
}
