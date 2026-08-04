import { Beliefs } from "./bdi/beliefs.js";
import { ObjectiveStore } from "./bdi/objectives.js";
import { Planner } from "./bdi/planning.js";
import { runAgentLoop } from "./bdi/loop.js";

/**
 * Starts one BDI loop without awaiting the non-terminating cycle.
 * @param {object} socket
 * @returns {import("./bdi/beliefs.js").Beliefs}
 */
export function startBdiAgent(socket) {
    // Each socket owns its beliefs, planner and objectives; its loop runs in the background.
    const beliefs = new Beliefs();
    const planner = new Planner();
    const objectives = new ObjectiveStore();

    beliefs.init(socket, { objectives });
    runAgentLoop(beliefs, planner, socket, { objectives }).catch((error) => {
        console.error(`[${beliefs.me.name || "agent"}] fatal error:`, error);
        process.exitCode = 1;
    });

    return beliefs;
}
