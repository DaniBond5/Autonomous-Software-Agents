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
 * Resolves a pickup or putdown objective from the real server outcome.
 * @param {import("./desires.js").Desire | null} intention
 * @param {import("./execution.js").ActionOutcome} outcome
 * @param {import("./objectives.js").ObjectiveStore | null} objectives
 * @returns {boolean} whether the outcome belongs to an external action objective
 */
function settleActionObjective(intention, outcome, objectives) {
    const actionType = outcome?.action?.action;
    const expectedObjectiveType = actionType === "pickup"
        ? "pick_up_here"
        : actionType === "putdown"
            ? "put_down_here"
            : null;
    if (!expectedObjectiveType
        || intention?.type !== expectedObjectiveType
        || !intention.objectiveId) return false;

    const objectiveId = intention.objectiveId;
    if (!objectives?.isActive(objectiveId)) return true;

    const result = outcome.result;
    if (outcome.status === "succeeded"
        && Array.isArray(result)
        && result.length > 0) {
        const action = actionType === "pickup" ? "picked up" : "put down";
        const parcels = result.length === 1 ? "parcel" : "parcels";
        objectives.complete(
            objectiveId,
            `${action} ${result.length} ${parcels}`
        );
        return true;
    }

    if (Array.isArray(result) && result.length === 0) {
        objectives.fail(
            objectiveId,
            actionType === "pickup"
                ? "no parcels were picked up"
                : "no parcels were put down"
        );
        return true;
    }

    const error = outcome.error;
    const reason = error instanceof Error
        ? error.message
        : error != null
            ? String(error)
            : `${actionType} failed`;
    objectives.fail(objectiveId, reason);
    return true;
}

/**
 * This function runs the BDI control loop of one agent.
 * The loop lives here, and not in the entry point, so a second agent can run
 * the same cycle on its own beliefs and planner.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("./planning.js").Planner} planner
 * @param {object} socket
 * @param {{objectives?: import("./objectives.js").ObjectiveStore | null}} [options]
 */
export async function runAgentLoop(
    beliefs,
    planner,
    socket,
    { objectives = null } = {}
) {
    let currentIntention = null;

    console.log(`[${beliefs.me.name || "agent"}] loop started`);

    while (true) {
        const desires = planner.filterPlannableDesires(
            generateDesires(beliefs, objectives),
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

        const objectiveId = currentIntention?.objectiveId ?? null;
        if (objectiveId && !objectives?.isActive(objectiveId)) {
            currentIntention = null;
            planner.resetPlanningState("objective no longer active");
            continue;
        }
        if (planningResult.status === "idle"
            && objectiveId
            && currentIntention.type === "go_to_tile"
            && objectives?.isActive(objectiveId)) {
            const { x, y } = currentIntention.target;
            objectives.complete(objectiveId, `reached target (${x},${y})`);
            currentIntention = null;
            continue;
        }

        if (planningResult.status === "unreachable"
            || planningResult.status === "deferred") {
            if (planningResult.status === "unreachable"
                && objectiveId
                && objectives?.isActive(objectiveId)) {
                objectives.fail(
                    objectiveId,
                    planningResult.reason || "target is unreachable"
                );
                planner.resetPlanningState("external objective failed");
                beliefs.partner.announceIntention(null);
            }
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

        // The LLM only requests pickup or putdown. The normal BDI executor sends the
        // action, beliefs are reconciled above, and the real outcome resolves the tool.
        const externalActionFinished = settleActionObjective(
            currentIntention,
            outcome,
            objectives
        );

        const actionType = outcome?.action?.action;
        const isTerminalAction = actionType === "pickup"
            || actionType === "putdown";

        if (isTerminalAction) {
            if (externalActionFinished) {
                planner.resetPlanningState("external action finished");
                beliefs.partner.announceIntention(null);
            }
            currentIntention = null;
        }

        if (outcome.status !== "succeeded") {
            await wait(IDLE_WAIT_MS);
        }
    }
}
