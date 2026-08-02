import config from "../config.js";
import { executeAction } from "../bdi/execution.js";
import { wait } from "../bdi/loop.js";
import { applyRule } from "../bdi/rules.js";
import { describeState } from "./memory.js";

const dbg = (...args) => {
    if (config.debug) console.log("[llm]", ...args);
};

// A walk that has not arrived in this many actions is stuck behind something
// the planner keeps routing around. Ending it returns control to the model,
// which can then try another tile instead of blocking the whole mission.
const MAX_WALK_STEPS = 60;

// Same breather the BDI loop takes after an action that changed nothing.
const IDLE_WAIT_MS = 200;

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
    return {
        x: Number(numbers[0]),
        y: Number(numbers[1]),
        seconds: Number(numbers[2])
    };
}

/**
 * The tools the model can call, and the only place they are described.
 * The system prompt is generated from this registry, so a new tool becomes
 * available to the model as soon as it is added here.
 * Every tool returns a string, because that string is the observation the
 * model reads next. A tool that fails says so instead of throwing.
 */
export class LLMExecutor {
    /**
     * @param {{beliefs: import("../bdi/beliefs.js").Beliefs,
     *          planner: import("../bdi/planning.js").Planner,
     *          socket: object,
     *          memory: import("./memory.js").LLMMemory}} parts
     */
    constructor({ beliefs, planner, socket, memory }) {
        this.beliefs = beliefs;
        this.planner = planner;
        this.socket = socket;
        this.memory = memory;

        /** True while a mission is running, which is when the BDI loop stands down. */
        this.onMission = false;

        /** Who sent the current mission, so replies go back to them. */
        this.senderId = null;

        this.tools = {
            get_state: {
                description: "Read the game state: your position and score, the "
                    + "parcels you carry, the parcels and delivery tiles you can "
                    + "see, and the size of the map. Use it before deciding "
                    + "anything that depends on where things are.",
                run: async () => describeState(this.beliefs),
            },
            go_to: {
                description: "Walk to a tile. Input is the pair of coordinates, "
                    + "for example 4,7. Returns when you arrive or when the tile "
                    + "cannot be reached.",
                run: input => this.walkTo(input),
            },
            pick_up: {
                description: "Pick up the parcels lying on the tile you are "
                    + "standing on. Walk there first.",
                run: () => this.act("pickup"),
            },
            put_down: {
                description: "Drop the parcels you carry on the tile you are "
                    + "standing on. On a delivery tile they are scored.",
                run: () => this.act("putdown"),
            },
            calculate: {
                description: "Work out an arithmetic expression, for example "
                    + "4*2+1. Use it whenever a mission gives a coordinate as a "
                    + "sum or a product instead of a number.",
                run: async input => {
                    const value = evaluateExpression(input);
                    return value === null
                        ? `cannot compute "${input}": only numbers, + - * / and parentheses are allowed`
                        : `${input} = ${value}`;
                },
            },
            // The five tools below do not take the game over: they write a rule into the
            // deliberation the agent already runs, and the agent keeps playing on its own with
            // the rule in force. A mission that changes the rules of the game is therefore
            // read it, register it, reply, resume_autonomous, and the agent plays on. That is
            // the difference from a mission that is a list of moves, which the tools above do.
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
                    if (!tile) return `cannot read "${input}" as a tile: write it as x,y`;
                    this.beliefs.rules.avoidTile(tile);
                    return `avoiding (${tile.x},${tile.y}) from now on`;
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
                    return lifted === 0
                        ? "there were no rules to lift"
                        : `lifted ${lifted} rules: scoring is back to normal`;
                },
            },
            reply: {
                description: "Send a message in the chat to the player who gave "
                    + "you the mission. Input is the text to send.",
                run: input => this.reply(input),
            },
            resume_autonomous: {
                description: "End the mission and go back to playing on your own. "
                    + "Use it once the mission is done, or when there is no "
                    + "mission to do.",
                run: async () => this.leaveMission("mission finished"),
            },
            decline_mission: {
                description: "Refuse the mission and go back to playing on your "
                    + "own. Input is why it is not worth doing, for example a "
                    + "negative reward or a walk too long for what it pays.",
                run: async input => {
                    const reason = String(input ?? "").trim() || "not worth it";
                    if (this.senderId) await this.reply(`Declining: ${reason}`);
                    return this.leaveMission(`mission declined: ${reason}`);
                },
            },
        };
    }

    /**
     * Starts a mission: the BDI loop stands down until a tool ends it.
     * @param {string | null} senderId who asked, or null for the default goal
     */
    beginMission(senderId) {
        this.onMission = true;
        this.senderId = senderId;
    }

    /**
     * Hands control back to the BDI loop. Both exits go through here, but they
     * keep separate names in the log: a mission that was done and one that was
     * turned down are different decisions.
     * @param {string} reason
     * @returns {string}
     */
    leaveMission(reason) {
        console.log(`[llm] ${reason}: back to autonomous play`);
        this.onMission = false;
        this.senderId = null;
        return `${reason}. Now playing autonomously.`;
    }

    /**
     * Runs one tool and returns its observation.
     * Nothing thrown here reaches the planner: a broken tool is one more
     * observation to reason about, not a crashed turn.
     * @param {string} name
     * @param {string} input
     * @returns {Promise<string>}
     */
    async run(name, input) {
        const tool = this.tools[name];
        if (!tool) {
            return `there is no tool called "${name}". `
                + `Available tools: ${Object.keys(this.tools).join(", ")}`;
        }
        dbg(`${name}(${input ?? ""})`);
        try {
            return await tool.run(input);
        } catch (error) {
            return `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Walks to a tile with the Part A planner, one action at a time.
     * The intention is the one the plan library already knows how to serve
     * without a terminal action, so BFS, detours and the crate planner come
     * for free.
     * @param {string} input
     * @returns {Promise<string>}
     */
    async walkTo(input) {
        const target = parseTile(input);
        if (!target) return `cannot read "${input}" as a tile: write it as x,y`;

        const intention = { type: "go_to_tile", target, utility: 0 };
        for (let step = 0; step < MAX_WALK_STEPS; step += 1) {
            const plan = await this.planner.planNextAction(intention, this.beliefs);

            if (plan.status === "idle") return `arrived at (${target.x},${target.y})`;
            if (plan.status === "unreachable" || plan.status === "deferred") {
                return `cannot reach (${target.x},${target.y}): ${plan.reason}`;
            }
            if (plan.status === "wait") {
                await wait(IDLE_WAIT_MS);
                continue;
            }

            const outcome = await executeAction(plan.action, this.beliefs, this.socket);
            this.beliefs.crates.reconcileActionOutcome(outcome);
            this.planner.reconcilePlanningOutcome(outcome, this.beliefs);
            if (outcome.status !== "succeeded") await wait(IDLE_WAIT_MS);
        }
        return `gave up walking to (${target.x},${target.y}) after ${MAX_WALK_STEPS} steps`;
    }

    /**
     * Picks up or puts down on the current tile, reusing the Part A execution.
     * @param {'pickup'|'putdown'} type
     * @returns {Promise<string>}
     */
    async act(type) {
        const outcome = await executeAction({ action: type }, this.beliefs, this.socket);
        this.beliefs.parcels.reconcileActionOutcome(
            outcome,
            this.beliefs.me.id,
            this.beliefs.me.pos
        );
        const here = `(${this.beliefs.me.pos.x},${this.beliefs.me.pos.y})`;
        if (outcome.status !== "succeeded") {
            return type === "pickup"
                ? `nothing to pick up at ${here}`
                : `nothing to put down at ${here}`;
        }
        return `${type === "pickup" ? "picked up" : "put down"} `
            + `${outcome.result.length} parcels at ${here}`;
    }

    /**
     * Registers a scoring rule written by the model, and passes it to the partner.
     * A rule of the game binds the team, but the mission was only sent to one of us.
     * @param {string} input the rule as JSON
     * @returns {Promise<string>}
     */
    async registerRule(input) {
        let raw;
        try {
            raw = JSON.parse(String(input ?? ""));
        } catch {
            // A rejected tool call is a message the model can act on, so it says what a good
            // one looks like rather than only that this one was bad.
            return 'that is not JSON. Write one object, for example '
                + '{"id":"stack3","axis":"stack_count","equals":3,"multiplier":2}';
        }

        const result = applyRule(this.beliefs.rules, raw);
        if (!result.ok) return `rule refused: ${result.reason}`;

        // What goes on the wire is the rule as written, not as stored: the partner puts it
        // through the same validation this agent just did, and that reads the written shape.
        this.beliefs.partner.sendRule(raw);
        return `rule ${result.rule.id} is in force: ${result.summary}`;
    }

    /**
     * Sends this agent to a tile for a while.
     * @param {string} input tile and seconds
     * @returns {Promise<string>}
     */
    async hold(input) {
        const hold = parseHold(input);
        if (!hold) return `cannot read "${input}": write it as x,y seconds`;

        const result = applyRule(this.beliefs.rules, {
            id: `hold ${hold.x},${hold.y}`,
            ...hold
        });
        return result.ok ? result.summary : `cannot hold there: ${result.reason}`;
    }

    /**
     * Sends the partner to a tile for a while. The name says partner, so nothing is
     * registered here: this agent carries on with what it was doing.
     * @param {string} input tile and seconds
     * @returns {Promise<string>}
     */
    async sendPartnerTo(input) {
        const hold = parseHold(input);
        if (!hold) return `cannot read "${input}": write it as x,y seconds`;
        if (!this.beliefs.partner.isKnown) return "there is no other agent to send";

        this.beliefs.partner.sendRule({ id: `hold ${hold.x},${hold.y}`, ...hold });
        return `asked the other agent to wait at (${hold.x},${hold.y}) `
            + `for ${hold.seconds} seconds`;
    }

    /**
     * @param {string} message
     * @returns {Promise<string>}
     */
    async reply(message) {
        const text = String(message ?? "").trim();
        if (!text) return "nothing to say: the message was empty";
        if (!this.senderId) return "nobody to reply to: this goal came from no one";
        const status = await this.socket.emitSay(this.senderId, text);
        return `message sent (${status})`;
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

Tiles are addressed as x,y. x grows to the right and y grows upwards, both from 0.

Your tools:
${tools}

Decide whether a mission is worth doing before you start it. You are giving up
ordinary play to run it, so it has to pay for itself:
- a mission that awards negative points is never worth doing;
- a mission whose walk is long compared to what it pays is not worth doing
  either, because delivering ordinary parcels in that time pays more;
- when a mission is not worth it, call decline_mission and say why.
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
you choose the next step. End every mission with resume_autonomous or
decline_mission, so you go back to playing on your own.`;
}
