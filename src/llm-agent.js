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

/** @returns {string} */
function messageText(message) {
    if (typeof message === "string") return message.trim();
    return String(message?.text ?? message?.message ?? "").trim();
}

function isMissionSender(id, name) {
    const allowed = config.llm.missionSender;
    return !allowed || allowed === id || allowed === name;
}

/**
 * Starts the LLM-facing agent and its BDI actuator loop.
 * @param {object} socket
 * @returns {import("./bdi/beliefs.js").Beliefs}
 */
export function startLlmAgent(socket) {
    // Each socket owns its beliefs, planner and objectives.
    const beliefs = new Beliefs();
    const planner = new Planner();
    const objectives = new ObjectiveStore();
    beliefs.init(socket, { objectives });

    const memory = new LLMMemory(beliefs);
    const executor = new LLMExecutor({ beliefs, socket, objectives });
    const agent = new LLMAgent({
        memory,
        executor,
        planner: new LLMPlanner(new LLMClient()),
        replanner: new LLMReplanner(),
    });

    socket.onMsg((id, name, message) => {
        // Partner protocol messages are handled by Beliefs, never as missions.
        if (id === beliefs.partner.id) return;

        const text = messageText(message);
        if (!text) return;
        if (!isMissionSender(id, name)) return;
        console.log(`[llm] mission from ${name}: ${text}`);
        void agent.handleMission(text, id).catch((error) => {
            console.error("[llm] mission refused:", error);
        });
    });

    // The BDI loop remains the only physical actuator and runs in the background.
    runAgentLoop(beliefs, planner, socket, {
        objectives,
    }).catch((error) => {
        console.error("[llm] fatal error:", error);
        process.exitCode = 1;
    });

    return beliefs;
}
