import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

import config from "./config.js";
import { startBdiAgent } from "./bdi-agent.js";
import { startLlmAgent } from "./llm-agent.js";

/** The two agents that can be run on their own. No argument runs the pair. */
const SOLO_MODES = ["bdi", "llm"];

const connect = token => DjsConnect(config.deliveroo.host, token);

/**
 * Resolves once the server has told an agent who it is.
 * The socket is an event emitter, so this listener sits beside the one Beliefs registers
 * rather than replacing it.
 * @param {object} socket
 * @returns {Promise<string>} the agent's own id
 */
function ownId(socket) {
    return new Promise((resolve) => {
        socket.onYou(({ id }) => resolve(id));
    });
}

/**
 * Starts one agent or both, and when both, introduces them to each other.
 *
 * Two agents built to collaborate should not have to discover one another. Their ids are
 * assigned by the server, but whoever starts them both learns each id and can simply hand it
 * over, which is why this file exists and the name matching it replaced does not.
 */
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

    // Only the socket that mode needs, so playing alone works on half a .env. Solo is the
    // baseline the coordinating pair is measured against, and it must not ask for a token
    // belonging to an agent that is not running.
    if (mode === "bdi") {
        startBdiAgent(connect(config.deliveroo.agents.bdi.token));
        return;
    }
    if (mode === "llm") {
        startLlmAgent(connect(config.deliveroo.agents.llm.token));
        return;
    }

    // One Beliefs and one Planner per agent, which is what lets both run in this one process
    // without overwriting each other's world.
    const bdiSocket = connect(config.deliveroo.agents.bdi.token);
    const llmSocket = connect(config.deliveroo.agents.llm.token);
    const bdi = startBdiAgent(bdiSocket);
    const llm = startLlmAgent(llmSocket);

    // Every `you` listener, the two inside the start functions above and the two below, is
    // registered in this one synchronous block, and the server cannot deliver an event until
    // it ends. An await placed anywhere before this line loses the event for whichever agent
    // is still waiting, and the launcher hangs without introducing them.
    const [bdiId, llmId] = await Promise.all([ownId(bdiSocket), ownId(llmSocket)]);
    bdi.partner.connected(llmId);
    llm.partner.connected(bdiId);
    console.log(`[main] bdi is ${bdiId}, llm is ${llmId}`);
}

main().catch((error) => {
    console.error("[main] fatal error:", error);
    process.exitCode = 1;
});
