import { socket } from "./connection.js";
import { beliefs } from "./bdi/beliefs.js";
import { selectIntention, executeIntention } from "./bdi/intentions.js";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

beliefs.init(socket);

async function agentLoop() {
    console.log("Agent loop started");
    while (true) {
        const intention = selectIntention(beliefs);   // deliberate
        if (intention) {
            await executeIntention(beliefs, intention); // act
        } else {
            console.log("[IDLE] nothing worth doing");
        }
        await sleep(500);
    }
}

agentLoop();