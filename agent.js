import { socket } from "./connection.js";
import { beliefs } from "./bdi/beliefs.js";
import { reviseIntention, executeIntention } from "./bdi/intentions.js";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

beliefs.init(socket);

let currentIntention = null;

async function agentLoop() {
    console.log("Agent loop started");
    while (true) {
        currentIntention = reviseIntention(currentIntention, beliefs);
        const acted = currentIntention
            ? await executeIntention(beliefs, currentIntention, socket)
            : false;
        if (!acted) await sleep(200); // idle or empty plan — don't spin
    }
}

agentLoop();
