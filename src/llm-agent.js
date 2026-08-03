import config from "./config.js";
import { Beliefs } from "./bdi/beliefs.js";
import { Planner } from "./bdi/planning.js";
import { runAgentLoop } from "./bdi/loop.js";
import { ObjectiveStore } from "./bdi/objectives.js";
import { LLMClient } from "./llm/client.js";
import { LLMMemory } from "./llm/memory.js";
import { LLMPlanner } from "./llm/planner.js";
import { LLMReplanner } from "./llm/replanner.js";
import { LLMExecutor } from "./llm/executor.js";
import { LLMAgent } from "./llm/core.js";

/**
 * Reads the text out of a chat message. The server passes on whatever the
 * sender wrote, which is a string from the game chat but an object from
 * another agent.
 * @param {*} message
 * @returns {string}
 */
function messageText(message) {
    if (typeof message === "string") return message.trim();
    return String(message?.text ?? message?.message ?? "").trim();
}

/**
 * Whether a message is one of the two agents talking to each other.
 * Beliefs handles those, and reading one here would turn a parcel report into a goal.
 * @param {*} message
 * @returns {boolean}
 */
function isProtocolMessage(message) {
    return typeof message === "object"
        && message !== null
        && typeof message.kind === "string"
        && Number.isFinite(message.v);
}

/**
 * Whether a message may set a goal. With no filter configured anyone can,
 * which is what a real game needs; during a test the filter keeps the agent
 * from reacting to the chat of every other player.
 * @param {string} id
 * @param {string} name
 * @returns {boolean}
 */
function isMissionSender(id, name) {
    const allowed = config.llm.missionSender;
    return !allowed || allowed === id || allowed === name;
}

/**
 * Builds the LLM agent on a socket and starts its cycle.
 * Like the BDI entry point, the loop never returns, so it is started rather than awaited and
 * the beliefs come back for the launcher to wire a partner into.
 * @param {object} socket
 * @returns {import("./bdi/beliefs.js").Beliefs} this agent's beliefs
 */
export function startLlmAgent(socket) {
    // Its own beliefs and planner on its own socket: the LLM agent reuses the
    // Part A machinery without sharing state with the BDI agent.
    const beliefs = new Beliefs();
    const planner = new Planner();
    const objectives = new ObjectiveStore();
    beliefs.init(socket);

    const memory = new LLMMemory(beliefs);
    const executor = new LLMExecutor({ beliefs, socket, objectives });
    const agent = new LLMAgent({
        memory,
        executor,
        planner: new LLMPlanner(new LLMClient()),
        replanner: new LLMReplanner(),
    });

    socket.onMsg((id, name, message) => {
        // The partner talks on this same channel. The sender check is the point, the shape check
        // covers the window before the launcher has handed over the partner's id.
        if (id === beliefs.partner.id || isProtocolMessage(message)) return;

        const text = messageText(message);
        if (!text) return;
        if (!isMissionSender(id, name)) return;
        console.log(`[llm] mission from ${name}: ${text}`);
        try {
            agent.enqueueMission(text, id);
        } catch (error) {
            console.error("[llm] mission refused:", error);
        }
    });

    runAgentLoop(beliefs, planner, socket, {
        objectives,
    }).catch((error) => {
        console.error("[llm] fatal error:", error);
        process.exitCode = 1;
    });

    return beliefs;
}
