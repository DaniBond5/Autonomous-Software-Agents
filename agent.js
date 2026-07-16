import { socket } from "./connection.js";
import { beliefs } from "./bdi/beliefs.js";
import { generateDesires } from "./bdi/desires.js";
import { reviseIntention } from "./bdi/intentions.js";
import { planNextAction } from "./bdi/planning.js";
import { executeAction } from "./bdi/execution.js";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

beliefs.init(socket);

let currentIntention = null;

async function agentLoop() {
    console.log("Agent loop started");
    while (true) {
        const desires = generateDesires(beliefs);
        currentIntention = reviseIntention(currentIntention, beliefs, desires);
        const action = currentIntention
            ? planNextAction(currentIntention, beliefs)
            : null;
        const outcome = await executeAction(action, beliefs, socket);
        beliefs.parcels.reconcileActionOutcome(outcome, beliefs.me.id, beliefs.me.pos);
        if (outcome.status !== 'succeeded') await sleep(200); // idle or failed action — don't spin
    }
}

agentLoop();
