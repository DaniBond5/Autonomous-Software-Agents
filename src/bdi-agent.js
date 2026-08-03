import { Beliefs } from "./bdi/beliefs.js";
import { Planner } from "./bdi/planning.js";
import { runAgentLoop } from "./bdi/loop.js";

/**
 * Builds the BDI agent on a socket and starts its cycle.
 * The loop never returns, so it is started rather than awaited: the caller gets the beliefs
 * back, which is where a partner is wired once there is one.
 * @param {object} socket
 * @returns {import("./bdi/beliefs.js").Beliefs} this agent's beliefs
 */
export function startBdiAgent(socket) {
    // Beliefs and planning state belong to one agent.
    const beliefs = new Beliefs();
    const planner = new Planner();

    beliefs.init(socket);
    runAgentLoop(beliefs, planner, socket).catch((error) => {
        console.error("[agent] fatal error:", error);
        process.exitCode = 1;
    });

    return beliefs;
}
