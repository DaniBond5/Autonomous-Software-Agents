import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

import config from "./config.js";
import { startBdiAgent } from "./bdi-agent.js";
import { startLlmAgent } from "./llm-agent.js";

const SOLO_MODES = ["bdi", "llm"];

const connect = token => DjsConnect(config.deliveroo.host, token);

// Register this listener before any await so the first identity event cannot be missed.
/** @returns {Promise<string>} */
function ownId(socket) {
    return new Promise((resolve) => {
        socket.onYou(({ id }) => resolve(id));
    });
}

// Start one agent or both, then connect the pair once both ids are known.
async function main() {
    const mode = process.argv[2] ?? null;
    if (mode !== null && !SOLO_MODES.includes(mode)) {
        console.error(
            `[main] unknown mode "${mode}". `
            + `Use "bdi", "llm", or no argument to run both.`
        );
        process.exitCode = 1;
        return;
    }

    if (mode === "bdi") {
        startBdiAgent(connect(config.deliveroo.agents.bdi.token));
        return;
    }
    if (mode === "llm") {
        startLlmAgent(connect(config.deliveroo.agents.llm.token));
        return;
    }

    // Two agents run in one process, each with its own socket, beliefs and planner.
    const bdiSocket = connect(config.deliveroo.agents.bdi.token);
    const llmSocket = connect(config.deliveroo.agents.llm.token);
    const bdi = startBdiAgent(bdiSocket);
    const llm = startLlmAgent(llmSocket);

    // Register both identity listeners before awaiting either connection.
    const [bdiId, llmId] = await Promise.all([ownId(bdiSocket), ownId(llmSocket)]);
    bdi.partner.connected(llmId);
    llm.partner.connected(bdiId);
    console.log(`[main] bdi is ${bdiId}, llm is ${llmId}`);
}

main().catch((error) => {
    console.error("[main] fatal error:", error);
    process.exitCode = 1;
});
