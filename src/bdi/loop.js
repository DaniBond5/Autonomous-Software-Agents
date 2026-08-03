import config from "../config.js";
import { desireKey, generateDesires } from "./desires.js";
import { reviseIntention } from "./intentions.js";
import { executeAction } from "./execution.js";

// Breather after a cycle that produced no successful action, so a blocked or
// idle agent does not spin against the server. Longer makes it slow to react,
// shorter just burns cycles re-planning an unchanged world.
const IDLE_WAIT_MS = 200;

// Both agents run this same loop in one process, so every line says which of the two wrote
// it. The name comes from the token and is not known until the server sends it.
const dbg = (beliefs, ...args) => {
    if (config.debug) console.log(`[${beliefs.me.name || "agent"}]`, ...args);
};

export const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The identity of an intention, or null when there is none.
 * Having no goal is a state the partner has to hear about too, so the comparison has to survive it.
 * @param {import("./desires.js").Desire | null} intention
 * @returns {string | null}
 */
const intentionKey = (intention) =>
    intention ? desireKey(intention) : null;

/**
 * This function runs the BDI control loop of one agent.
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

    console.log(`[${beliefs.me.name || "agent"}] loop started`);

    while (true) {
        if (isSuspended()) {
            // Dropping the goal once on suspension means the agent replans from
            // the world it finds when it takes back control, not from a stale one.
            if (currentIntention) {
                currentIntention = null;
                planner.resetPlanningState("control handed over");
                // The parcel this agent was walking to is free again. A claim left standing would
                // make the partner keep away from a parcel nobody is going to collect.
                beliefs.partner.announceIntention(null);
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
        const intentionChanged =
            intentionKey(previousIntention) !== intentionKey(currentIntention);

        // One line per goal change, so the log tells apart a goal that was
        // outranked from one that left the desire set. The old utility comes
        // from the current desires: a value computed cycles ago is not
        // comparable with a fresh one, so a goal that is gone says so.
        if (intentionChanged && previousIntention && currentIntention) {
            const left = desires.find(
                desire => desireKey(desire) === desireKey(previousIntention)
            );
            dbg(
                beliefs,
                `intention changed: left ${desireKey(previousIntention)} `
                + `(utility ${left ? left.utility.toFixed(2) : "gone"}), `
                + `took ${desireKey(currentIntention)} `
                + `(utility ${currentIntention.utility.toFixed(2)})`
            );
        }

        // The partner decides whether to go for a parcel by comparing its distance against ours,
        // so it needs to hear about a commitment as soon as it is made.
        // Releasing a claim rests on desire generation always offering at least an exploration
        // option: were the intention null on two cycles running, no change would be seen here.
        if (intentionChanged) {
            beliefs.partner.announceIntention(currentIntention);
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
