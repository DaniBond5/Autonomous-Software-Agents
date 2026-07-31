import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

import config from "./config.js";
import { Beliefs } from "./bdi/beliefs.js";
import { Planner } from "./bdi/planning.js";
import { runAgentLoop } from "./bdi/loop.js";
import { LLMClient } from "./llm/client.js";
import { LLMMemory } from "./llm/memory.js";
import { LLMPlanner } from "./llm/planner.js";
import { LLMReplanner } from "./llm/replanner.js";
import { LLMExecutor } from "./llm/executor.js";
import { LLMAgent, DEFAULT_GOAL } from "./llm/llm-agent.js";

const socket = DjsConnect(
    config.deliveroo.host,
    config.deliveroo.agents.llm.token
);

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

async function main() {
    // Its own beliefs and planner on its own socket: the LLM agent reuses the
    // Part A machinery without sharing state with the BDI agent.
    const beliefs = new Beliefs();
    const planner = new Planner();
    beliefs.init(socket);

    const memory = new LLMMemory(beliefs);
    const executor = new LLMExecutor({ beliefs, planner, socket, memory });
    const agent = new LLMAgent({
        memory,
        executor,
        planner: new LLMPlanner(new LLMClient()),
        replanner: new LLMReplanner(),
    });

    const setGoal = (goal, senderId) => {
        agent.setGoal(goal, senderId).catch(error =>
            console.error("[llm] goal abandoned:", error)
        );
    };

    socket.onMsg((id, name, message) => {
        const text = messageText(message);
        if (!text) return;
        if (!isMissionSender(id, name)) return;
        console.log(`[llm] mission from ${name}: ${text}`);
        setGoal(text, id);
    });

    // The first goal is ordinary play, and it travels the same path a mission
    // would. The agent reads it and hands itself over to the BDI loop below.
    setGoal(DEFAULT_GOAL, null);
    await runAgentLoop(beliefs, planner, socket, () => executor.onMission);
}

main().catch((error) => {
    console.error("[llm] fatal error:", error);
    process.exitCode = 1;
});
