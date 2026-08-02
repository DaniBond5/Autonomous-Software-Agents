import config from "../config.js";
import { executeAction } from "../bdi/execution.js";
import { wait } from "../bdi/loop.js";
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

        const intention = { type: "go_to_spawner", target, utility: 0 };
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
