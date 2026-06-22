import { socket } from "./connection.js";
import { beliefs } from "./bdi/beliefs.js";
import { selectIntention, executeIntention } from "./bdi/intentions.js";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

beliefs.init(socket);

async function agentLoop() {
    console.log("Agent loop started");
    while (true) {
        const intention = selectIntention(beliefs);
        const acted = intention
            ? await executeIntention(beliefs, intention, socket)
            : false;
        if (!acted) await sleep(200); // idle or empty plan — don't spin
    }
}

agentLoop();