import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

import config from "./config.js";
import { Beliefs } from "./bdi/beliefs.js";
import { Planner } from "./bdi/planning.js";
import { runAgentLoop } from "./bdi/loop.js";

const socket = DjsConnect(
    config.deliveroo.host,
    config.deliveroo.agents.bdi.token
);

async function main() {
    // Beliefs and planning state belong to one agent. Building them here is
    // what lets a second agent run in the same process without interference.
    const beliefs = new Beliefs();
    const planner = new Planner();

    beliefs.init(socket);
    await runAgentLoop(beliefs, planner, socket);
}

main().catch((error) => {
    console.error("[agent] fatal error:", error);
    process.exitCode = 1;
});
