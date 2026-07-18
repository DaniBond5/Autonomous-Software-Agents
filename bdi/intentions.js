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
            case 'go_deliver': {
                if (beliefs.parcels.carried.size === 0) break;

                const currentDelivery = desires.find(desire => desire.type === 'go_deliver');
                const bestPickup = selectBestDesire(
                    desires.filter(desire => desire.type === 'go_pick_up')
                );

                // Delivery persists unless a current pickup is strictly more useful.
                if (currentDelivery && bestPickup?.utility > currentDelivery.utility) {
                    return bestPickup;
                }
                if (currentDelivery) return currentDelivery;
                break;
            }
            case 'go_to_spawner': {
                const targetVisible = beliefs.world.isVisible(currentIntention.target);
                const pickupAvailable = desires.some(desire => desire.type === 'go_pick_up');
                if (!targetVisible && beliefs.parcels.carried.size === 0 && !pickupAvailable) {
                    return currentIntention;
                }
                break;
            }
        }
    }

    return selectBestDesire(desires);
}
