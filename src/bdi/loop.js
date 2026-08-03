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
 * @param {{objectives?: import("./objectives.js").ObjectiveStore | null,
 *          isSuspended?: () => boolean,
 *          getSuspensionRevision?: () => number}} [options]
 */
export async function runAgentLoop(
    beliefs,
    planner,
    socket,
    {
        objectives = null,
        isSuspended = () => false,
        getSuspensionRevision = () => 0,
    } = {}
) {
    let currentIntention = null;
    let handledSuspensionRevision = getSuspensionRevision();

    const handleRevisionChange = revision => {
        handledSuspensionRevision = revision;
        currentIntention = null;
        planner.resetPlanningState("direct physical action changed the world");
        beliefs.partner.announceIntention(null);
    };

    console.log(`[${beliefs.me.name || "agent"}] loop started`);

    while (true) {
        const revision = getSuspensionRevision();
        if (revision !== handledSuspensionRevision) {
            handleRevisionChange(revision);
        }
        if (isSuspended()) {
            await wait(IDLE_WAIT_MS);
            continue;
        }

        const desires = planner.filterPlannableDesires(
            generateDesires(beliefs, false, objectives),
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

        // The revision catches a direct action even when it finished during planning.
        // The boolean only tells whether that action is still running now.
        const latestRevision = getSuspensionRevision();
        if (latestRevision !== handledSuspensionRevision) {
            handleRevisionChange(latestRevision);
            continue;
        }
        if (isSuspended()) {
            await wait(IDLE_WAIT_MS);
            continue;
        }

        const objectiveId = currentIntention?.objectiveId ?? null;
        if (objectiveId && !objectives?.isActive(objectiveId)) {
            currentIntention = null;
            planner.resetPlanningState("objective no longer active");
            continue;
        }
        if (planningResult.status === "idle"
            && objectiveId
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
