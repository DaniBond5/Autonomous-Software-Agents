import config from "../config.js";
import { desireKey, generateDesires } from "./desires.js";
import { reviseIntention } from "./intentions.js";
import { executeAction } from "./execution.js";

// Breather after a cycle that produced no successful action, so a blocked or
// idle agent does not spin against the server. Longer makes it slow to react,
// shorter just burns cycles re-planning an unchanged world.
const IDLE_WAIT_MS = 200;

const dbg = (...args) => {
    if (config.debug) console.log("[agent]", ...args);
};

export const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the BDI control loop of one agent.
 * The loop lives here, and not in the entry point, so a second agent can run
 * the same cycle on its own beliefs and planner.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("./planning.js").Planner} planner
 * @param {object} socket
 * @param {() => boolean} [isSuspended] true while something else drives the
 *        agent, for instance an LLM mission. The loop then stops acting.
 */
export async function runAgentLoop(beliefs, planner, socket, isSuspended = () => false) {
    let currentIntention = null;

    console.log("[agent] loop started");

    while (true) {
        if (isSuspended()) {
            // Dropping the goal once on suspension means the agent replans from
            // the world it finds when it takes back control, not from a stale one.
            if (currentIntention) {
                currentIntention = null;
                planner.resetPlanningState("control handed over");
            }
            await wait(IDLE_WAIT_MS);
            continue;
        }

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
