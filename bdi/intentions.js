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

/**
 * Keeps the current intention while its goal is still valid, otherwise
 * replaces it with the currently most useful desire.
 * @param {import("./desires.js").Desire | null} currentIntention
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {import("./desires.js").Desire[]} desires
 * @returns {import("./desires.js").Desire | null}
 */
export function reviseIntention(currentIntention, beliefs, desires) {
    if (currentIntention) {
        switch (currentIntention.type) {
            case 'go_pick_up': {
                const pickupStillAvailable = desires.some(desire =>
                    desire.type === 'go_pick_up' && desire.id === currentIntention.id
                );
                if (pickupStillAvailable) return currentIntention;
                break;
            }
            case 'go_deliver':
                if (beliefs.parcels.carried.size > 0) return currentIntention;
                break;
            case 'go_to_spawner': {
                const reachedTarget = beliefs.me.pos.x === currentIntention.target.x
                    && beliefs.me.pos.y === currentIntention.target.y;
                const pickupAvailable = desires.some(desire => desire.type === 'go_pick_up');
                if (!reachedTarget && beliefs.parcels.carried.size === 0 && !pickupAvailable) {
                    return currentIntention;
                }
                break;
            }
        }
    }

    return selectBestDesire(desires);
}
