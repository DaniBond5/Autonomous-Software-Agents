import config from "../config.js";
import { desireKey, generateDesires } from "./desires.js";
import { reviseIntention } from "./intentions.js";
import { executeAction } from "./execution.js";

const IDLE_WAIT_MS = 200;

const dbg = (beliefs, ...args) => {
    if (config.debug) console.log(`[${beliefs.me.name || "agent"}]`, ...args);
};

export const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

const intentionKey = (intention) =>
    intention ? desireKey(intention) : null;

// Each desire type keeps the parcel id under its own field: handoff objectives
// use parcelId, autonomous pickups use id. Matching the type explicitly rather
// than falling back across fields stops a future desire that reuses `id` for
// something else from silently inheriting this attribution.
const intendedPickupParcelId = (intention) => {
    if (intention?.type === "handoff") return intention.parcelId;
    if (intention?.type === "go_pick_up") return intention.id;
    return undefined;
};

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

        if (intentionChanged) {
            beliefs.partner.announceIntention(currentIntention);
        }

        const planningResult = await planner.planNextAction(
            currentIntention,
            beliefs
        );
        const resetFromPlanning = objectives?.reconcilePlanning(
            currentIntention,
            planningResult,
            beliefs.me.pos
        ) ?? false;

        if (resetFromPlanning) {
            currentIntention = null;
            planner.resetPlanningState("external objective planning reconciled");
            beliefs.partner.announceIntention(null);
            if (planningResult.status !== "action") await wait(IDLE_WAIT_MS);
            continue;
        }

        if (planningResult.status !== "action") {
            if (planningResult.status === "unreachable"
                || planningResult.status === "deferred") {
                currentIntention = null;
                beliefs.partner.announceIntention(null);
            }
            await wait(IDLE_WAIT_MS);
            continue;
        }

        const outcome = await executeAction(planningResult.action, beliefs, socket);

        const actionType = outcome?.action?.action;
        // Action results carry no id, so name the parcel the action targeted.
        const intendedParcelId = actionType === "putdown"
            ? outcome.action.parcelId
            : actionType === "pickup"
                ? intendedPickupParcelId(currentIntention)
                : undefined;

        beliefs.parcels.reconcileActionOutcome(
            outcome,
            beliefs.me.id,
            beliefs.me.pos,
            beliefs.world.deliveries.has(
                `${beliefs.me.pos.x},${beliefs.me.pos.y}`
            ),
            intendedParcelId
        );
        const isParcelAction = actionType === "pickup"
            || actionType === "putdown";
        if (isParcelAction && outcome.status === "succeeded") {
            beliefs.shareCurrentState();
        }
        beliefs.crates.reconcileActionOutcome(outcome);
        const reconciliationResult = planner.reconcilePlanningOutcome(
            outcome,
            beliefs
        );
        const resetFromAction = objectives?.reconcileAction(
            currentIntention,
            outcome,
            beliefs.me.pos
        ) ?? false;

        const isTerminalAction = actionType === "pickup"
            || actionType === "putdown";

        if (resetFromAction) {
            planner.resetPlanningState("external objective action reconciled");
        }
        if (resetFromAction
            || reconciliationResult?.status === "deferred"
            || isTerminalAction) {
            currentIntention = null;
            beliefs.partner.announceIntention(null);
        }

        if (outcome.status !== "succeeded") {
            await wait(IDLE_WAIT_MS);
        }
    }
}
