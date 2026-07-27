import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

import config from "./config.js";
import { beliefs } from "./bdi/beliefs.js";
import { generateDesires } from "./bdi/desires.js";
import { reviseIntention } from "./bdi/intentions.js";
import {
    filterPlannableDesires,
    planNextAction,
    reconcilePlanningOutcome
} from "./bdi/planning.js";
import { executeAction } from "./bdi/execution.js";

const socket = DjsConnect(
    config.deliveroo.host,
    config.deliveroo.agents.bdi.token
);

const IDLE_WAIT_MS = 200;

const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

async function runAgentLoop() {
    let currentIntention = null;

    console.log("[agent] loop started");

    while (true) {
        const desires = filterPlannableDesires(
            generateDesires(beliefs),
            beliefs
        );

        currentIntention = reviseIntention(
            currentIntention,
            beliefs,
            desires
        );

        const planningResult = await planNextAction(
            currentIntention,
            beliefs
        );

        if (planningResult.status === "unreachable"
            || planningResult.status === "deferred") {
            currentIntention = null;
        }

        const action = planningResult.status === "action"
            ? planningResult.action
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
        beliefs.crates.reconcileActionOutcome(outcome);
        const reconciliationResult = reconcilePlanningOutcome(
            outcome,
            beliefs
        );
        if (reconciliationResult?.status === "deferred") {
            currentIntention = null;
        }

        const actionType = outcome?.action?.action;
        const isTerminalAction = actionType === "pickup"
            || actionType === "putdown";

        if (isTerminalAction) {
            currentIntention = null;
        }

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
    console.error("[agent] fatal error:", error);
    process.exitCode = 1;
});
