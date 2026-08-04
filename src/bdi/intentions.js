import { desireKey } from "./desires.js";

/** @returns {import("./desires.js").Desire | null} */
function selectBestDesire(desires) {
    if (desires.length === 0) return null;

    let best = desires[0];
    for (const desire of desires) {
        if (desire.utility > best.utility) best = desire;
    }
    return best;
}

/** @returns {boolean} */
function sameTarget(first, second) {
    return first.x === second.x && first.y === second.y;
}

/** @returns {boolean} */
function outranks(challenger, active) {
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
 * @param {import("./desires.js").Desire | null} currentIntention
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("./desires.js").Desire[]} desires
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

    // External objectives outrank autonomous desires and remain valid by objective id.
    const externalObjective = desires.find(desire => desire.objectiveId);
    if (externalObjective) return active?.objectiveId ? active : externalObjective;

    // Keep the delivery intention while its crate plan is committed.
    if (deliveryCrateCommitmentActive && active) return active;

    // A parcel on the current tile costs no movement.
    if (pickupHere) return pickupHere;

    if (!active) return selectBestDesire(desires);

    // Keep exploration until its desire disappears to avoid switching spawners mid-route.
    if (active.type === 'go_to_spawner') return active;

    // Select among valid challengers; another delivery must not hide a qualifying pickup.
    let challenger = null;
    for (const desire of desires) {
        if (!outranks(desire, active)) continue;
        if (!challenger || desire.utility > challenger.utility) challenger = desire;
    }
    return challenger ?? active;
}
