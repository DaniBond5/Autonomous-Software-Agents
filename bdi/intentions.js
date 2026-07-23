/* ------------------------------------------------------------------ */
/* DELIBERATION: what to pursue                                       */
/* ------------------------------------------------------------------ */

/** Selects the desire with the highest utility from an existing set. */
function selectBestDesire(desires) {
    if (desires.length === 0) return null;

    let best = desires[0];
    for (const desire of desires) {
        if (desire.utility > best.utility) best = desire;
    }
    return best;
}

/** Selects the highest-utility pickup or delivery without changing desire order. */
function selectBestConcreteDesire(desires) {
    let best = null;
    for (const desire of desires) {
        if (desire.type !== 'go_pick_up' && desire.type !== 'go_deliver') continue;
        if (!best || desire.utility > best.utility) best = desire;
    }
    return best;
}

/** Returns whether two desires refer to the same map tile. */
function sameTarget(first, second) {
    return first.x === second.x && first.y === second.y;
}

/**
 * Keeps the current intention while its goal is still valid, otherwise
 * replaces it with the currently most useful desire.
 * @param {import("./desires.js").Desire | null} currentIntention
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {import("./desires.js").Desire[]} desires
 * @returns {import("./desires.js").Desire | null}
 */
export function reviseIntention(currentIntention, beliefs, desires) {
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
    if (pickupHere) return pickupHere;

    if (currentIntention) {
        switch (currentIntention.type) {
            case 'go_pick_up': {
                const currentPickup = desires.find(desire =>
                    desire.type === 'go_pick_up' && desire.id === currentIntention.id
                );
                if (currentPickup) {
                    const bestConcrete = selectBestConcreteDesire(desires);
                    return bestConcrete?.utility > currentPickup.utility
                        ? bestConcrete
                        : currentPickup;
                }
                break;
            }
            case 'go_deliver': {
                if (beliefs.parcels.carried.size === 0) break;

                const currentDelivery = desires.find(desire =>
                    desire.type === 'go_deliver'
                    && sameTarget(desire.target, currentIntention.target)
                );
                if (currentDelivery) {
                    const bestConcrete = selectBestConcreteDesire(desires);
                    return bestConcrete?.utility > currentDelivery.utility
                        ? bestConcrete
                        : currentDelivery;
                }
                break;
            }
            case 'go_to_spawner': {
                const currentSpawner = desires.find(desire =>
                    desire.type === 'go_to_spawner'
                    && sameTarget(desire.target, currentIntention.target)
                );
                const targetVisible = beliefs.world.isVisible(currentIntention.target);
                const pickupAvailable = desires.some(desire => desire.type === 'go_pick_up');
                if (currentSpawner
                    && !targetVisible
                    && beliefs.parcels.carried.size === 0
                    && !pickupAvailable) {
                    return currentSpawner;
                }
                break;
            }
        }
    }

    return selectBestDesire(desires);
}
