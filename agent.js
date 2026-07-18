import { socket } from "./connection.js";
import { beliefs } from "./bdi/beliefs.js";
import { generateDesires } from "./bdi/desires.js";
import { reviseIntention } from "./bdi/intentions.js";
import { planNextAction } from "./bdi/planning.js";
import { executeAction } from "./bdi/execution.js";

const IDLE_WAIT_MS = 200;

const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

async function runAgentLoop() {
    let currentIntention = null;

    console.log("[agent] BDI loop started");

    while (true) {
        const desires = generateDesires(beliefs);

        currentIntention = reviseIntention(
            currentIntention,
            beliefs,
            desires
        );

        const action = currentIntention
            ? planNextAction(currentIntention, beliefs)
            : null;

        const outcome = await executeAction(
            action,
            beliefs,
            socket
        );

        beliefs.parcels.reconcileActionOutcome(
            outcome,
            beliefs.me.id,
            beliefs.me.pos
        );

        if (outcome.status !== "succeeded") {
            await wait(IDLE_WAIT_MS);
        }
    }
}

async function main() {
    beliefs.init(socket);
    await runAgentLoop();
}

main().catch((error) => {
    console.error("[agent] Fatal error:", error);
    process.exitCode = 1;
});