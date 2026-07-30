import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

import config from "./config.js";
import { Beliefs } from "./bdi/beliefs.js";
import { desireKey, generateDesires } from "./bdi/desires.js";
import { reviseIntention } from "./bdi/intentions.js";
import { Planner } from "./bdi/planning.js";
import { executeAction } from "./bdi/execution.js";

const socket = DjsConnect(
    config.deliveroo.host,
    config.deliveroo.agents.bdi.token
);

const IDLE_WAIT_MS = 200;

const dbg = (...args) => {
    if (config.debug) console.log("[agent]", ...args);
};

const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the BDI control loop of one agent.
 * @param {Beliefs} beliefs
 * @param {Planner} planner
 * @param {object} socket
 */
async function runAgentLoop(beliefs, planner, socket) {
    let currentIntention = null;

    console.log("[agent] loop started");

    while (true) {
        const desires = planner.filterPlannableDesires(
            generateDesires(beliefs),
            beliefs
        );
        const deliveryCrateCommitmentActive =
            currentIntention?.type === "go_deliver"
            && planner.isCrateTaskActiveFor(currentIntention);

        const previousIntention = currentIntention;
        currentIntention = reviseIntention(
            currentIntention,
            beliefs,
            desires,
            deliveryCrateCommitmentActive
        );
        // One line per goal change, so the log tells apart a goal that was
        // outranked from one that left the desire set. The old utility comes
        // from the current desires: a value computed cycles ago is not
        // comparable with a fresh one, so a goal that is gone says so.
        if (previousIntention && currentIntention
            && desireKey(previousIntention) !== desireKey(currentIntention)) {
            const left = desires.find(
                desire => desireKey(desire) === desireKey(previousIntention)
            );
            dbg(
                `intention changed: left ${desireKey(previousIntention)} `
                + `(utility ${left ? left.utility.toFixed(2) : "gone"}), `
                + `took ${desireKey(currentIntention)} `
                + `(utility ${currentIntention.utility.toFixed(2)})`
            );
        }

        const planningResult = await planner.planNextAction(
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
        const reconciliationResult = planner.reconcilePlanningOutcome(
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
