import { desireKey } from "./desires.js";

/**
 * This function returns the best desire given an array of desires.
 * The best desire is the one with the highest utility.
 * It returns null if the given array is empty.
 * @param {import("./desires.js").Desire[]} desires 
 * @returns {import("./desires.js").Desire | null} the best desire if there's at least one in the given array, null otherwise.
 */
function selectBestDesire(desires) {
    if (desires.length === 0) return null;

    let best = desires[0];
    for (const desire of desires) {
        if (desire.utility > best.utility) best = desire;
    }
    return best;
}

/**
 * This function compares two given Points and returns whether they're the same point or not.
 * @param {import("./desires.js").Point} first 
 * @param {import("./desires.js").Point} second 
 * @returns {boolean} true if the two points are the same, false otherwise.
 */
function sameTarget(first, second) {
    return first.x === second.x && first.y === second.y;
}

/**
 * This function checks and returns whether a challenger desire is worth abandoning the current goal (desire) for.
 * The strict comparison also excludes the current goal itself, which is one of the candidates.
 * @param {import("./desires.js").Desire} challenger
 * @param {import("./desires.js").Desire} active
 * @returns {boolean} true if the given challenger desire is worth abandoning the current goal for, false otherwise.
 */
function outranks(challenger, active) {
    // A tile goal that is already running is never given up: it ends when it expires, and
    // nothing outbids it in the meantime. Its utility only orders it against ordinary desires
    // while it is the challenger below, so that constant is a tie-breaker and not what keeps
    // the agent there. It could not be, since a scoring rule can multiply or add to a reward
    // without bound and would lift an ordinary pickup over any constant by accident.
    // This is tested first so that a hold does not yield to another hold either.
    if (active.type === 'go_to_tile') return false;

    // A tile goal the agent is not yet pursuing takes over from whatever is running, because it
    // is a mission the game gave the agent and it expires on its own. Without this the delivery
    // rule below would quietly refuse it whenever the agent happens to be carrying a parcel,
    // which is to say whenever the agent is doing well: the missions worth the most points
    // would be the ones that never ran.
    if (challenger.type === 'go_to_tile') return true;

    if (challenger.utility <= active.utility) return false;

    // A delivery under way is only given up for a pickup that is also closer.
    // A detour that is worth more still costs us the parcels we are
    // carrying, whose reward keeps decaying while we walk.
    if (active.type === 'go_deliver') {
        return challenger.type === 'go_pick_up'
            && challenger.distance < active.distance;
    }
    return true;
}

/**
 * This function applies the intention revision prescribed by the BDI architecture.
 * Given the current intention, the agent's beliefs and all of its desires,
 * this function revises the current desire and determines whether to continue 
 * pursuing the current desire or if it's best to switch it.
 * The current intention is kept while its goal is still valid, otherwise
 * it's replaced with the currently most useful desire.
 * @param {import("./desires.js").Desire | null} currentIntention
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("./desires.js").Desire[]} desires
 * @param {boolean} [deliveryCrateCommitmentActive=false]
 * @returns {import("./desires.js").Desire | null}
 */
export function reviseIntention(
    currentIntention,
    beliefs,
    desires,
    deliveryCrateCommitmentActive = false
) {
    const me = {
        x: Math.round(beliefs.me.pos.x),
        y: Math.round(beliefs.me.pos.y),
    };
    const pickupHere = desires.find(desire => {
        if (desire.type !== 'go_pick_up' || !sameTarget(desire.target, me)) {
            return false;
        }
        const visibleParcel = beliefs.parcels.visible.get(desire.id);
        return visibleParcel && sameTarget(visibleParcel, me);
    });
    const active = currentIntention?.objectiveId
        ? desires.find(desire =>
            desire.objectiveId === currentIntention.objectiveId
        )
        : currentIntention
            ? desires.find(desire => desireKey(desire) === desireKey(currentIntention))
            : null;

    // An external intention remains valid only while the store exposes the same objective id.
    // The rule is independent of whether the objective moves, picks up or puts down.
    const externalObjective = desires.find(desire => desire.objectiveId);
    if (externalObjective) return active?.objectiveId ? active : externalObjective;

    // 1. A crate plan is already being executed: do not touch the intention.
    if (deliveryCrateCommitmentActive && active) return active;

    // 2. A parcel is on the tile we already stand on: taking it costs no move.
    if (pickupHere) return pickupHere;

    // 3. The current goal is no longer supported by any desire.
    if (!active) return selectBestDesire(desires);

    // 4. An exploration target is kept until its desire disappears. One unseen
    //    spawner is as good as another, so re-ranking only wastes the moves
    //    already spent walking. Safe because an exploration desire is never in
    //    the set together with a pickup or a delivery.
    if (active.type === 'go_to_spawner') return active;

    // 5. Otherwise stay committed, unless a challenger beats the current goal.
    //    The best challenger is picked among those that qualify, not by testing
    //    the best desire overall: while delivering, the best overall is often
    //    another delivery, which would hide a pickup that does qualify.
    let challenger = null;
    for (const desire of desires) {
        if (!outranks(desire, active)) continue;
        if (!challenger || desire.utility > challenger.utility) challenger = desire;
    }
    return challenger ?? active;
}
