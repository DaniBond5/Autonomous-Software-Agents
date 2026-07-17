import { distance, distanceFromSearch, shortestPathsFrom } from "../utils/geometry.js";

/**
 * @typedef {{x: number, y: number}} Point
 */

/**
 * A desire is a candidate goal the agent could pursue. Every desire exposes
 * the SAME `target`, so the intention layer can move toward it without knowing
 * its type. The terminal action (pickup / putdown / nothing) is dispatched on `type`.
 *
 * @typedef {Object} Desire
 * @property {'go_pick_up'|'go_deliver'|'go_to_spawner'} type
 * @property {Point}  target   - where to move
 * @property {number} utility  - score from the utility functions
 * @property {string} [id]     - parcel id, ONLY for go_pick_up (used for intention revision)
 */

/**
 * Selects the reachable target with the shortest path from a starting position.
 * @param {import("../utils/geometry.js").ShortestPaths | null} search
 * @param {Iterable<Point>} targets
 * @returns {{target: Point, distance: number} | null}
 */
function nearestReachableTarget(search, targets) {
    let nearest = null;

    for (const target of targets) {
        const targetDistance = distanceFromSearch(search, target);
        if (targetDistance < (nearest?.distance ?? Infinity)) {
            nearest = { target, distance: targetDistance };
        }
    }

    return nearest;
}

/**
 * Computes the expected values for the number of carried parcels and of the carried reward.
 * For each carried parcel we compute its expected reward using a given distance.
 * If it's lte than 0, we count one less carried parcel and remove its reward, in order to be able to compute a more precise utility value.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {number} dist
 * @returns {[number, number]} [expectedNumCarriedParcels, expectedCarriedReward]
 */
export function expectedUtilityInfo(beliefs, dist) {
    let expectedNumBaggedParcels = beliefs.parcels.carried.size;
    let expectedBaggedReward = beliefs.parcels.carriedScore();
    let decayFrequency = beliefs.world.decayFrequency();
    for (let baggedParcel of beliefs.parcels.carried.values()) {
        let expectedParcelReward = baggedParcel.reward - (decayFrequency * dist);
        if (expectedParcelReward <= 0) {
            expectedNumBaggedParcels--;
            expectedBaggedReward -= baggedParcel.reward;
        }
    }
    return [expectedNumBaggedParcels, expectedBaggedReward];
}

/**
 * Computes the utility of picking up the given parcel.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel} parcel
 * @param {number} distanceToParcel
 * @param {number} distanceToDelivery
 * @returns {number} the path-efficiency utility for picking up the parcel.
 */
export function pickUpUtility(beliefs, parcel, distanceToParcel, distanceToDelivery) {
    const decayFrequency = beliefs.world.decayFrequency();
    const pickupCost = distanceToParcel + distanceToDelivery;

    const expectedInfo = expectedUtilityInfo(beliefs, pickupCost);
    const expectedNumBaggedParcels = expectedInfo[0];
    const expectedBaggedReward = expectedInfo[1] - ((decayFrequency * distanceToParcel) * expectedNumBaggedParcels);
    const expectedParcelReward = parcel.reward - decayFrequency * distanceToParcel;
    const expectedTotalDeliveredReward = (expectedParcelReward + expectedBaggedReward) - ((decayFrequency * distanceToDelivery) * (expectedNumBaggedParcels + 1));

    return expectedTotalDeliveredReward / Math.max(1, pickupCost);
}

/**
 * Computes the utility of delivering the carried parcels.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {number} distanceToDelivery
 * @returns {number} the path-efficiency utility for delivering.
 */
export function deliverUtility(beliefs, distanceToDelivery) {
    const expectedInfo = expectedUtilityInfo(beliefs, distanceToDelivery);
    const expectedNumBaggedParcels = expectedInfo[0];
    const expectedBaggedReward = expectedInfo[1];

    const decayFrequency = beliefs.world.decayFrequency();
    const expectedDeliveredReward = expectedBaggedReward - ((decayFrequency * distanceToDelivery) * expectedNumBaggedParcels);

    return expectedDeliveredReward / Math.max(1, distanceToDelivery);
}

/**
 * Computes the exploration utility using the path distance to the selected spawner.
 * Returns 0 when the expected reward is not positive.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {number} distanceToSpawner
 * @returns {number} the exploration utility (0 if not worth exploring).
 */
export function spawnerExplorationUtility(beliefs, distanceToSpawner) {
    let decayFrequency = beliefs.world.decayFrequency();

    let expectedReward = (beliefs.world.avgReward - (distanceToSpawner * decayFrequency));
    if (expectedReward <= 0) return 0;

    // TODO: might be useful to add a malus here.
    let utility = (expectedReward) / distanceToSpawner;
    return utility;
}

/**
 * Generates the current set of desires as plain objects, given the beliefs.
 * Desires are ephemeral data, regenerated every cycle.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {Desire[]} the generated desires.
 */
export function generateDesires(beliefs) {
    const desires = [];
    const knownParcels = beliefs.parcels.availableKnown(beliefs.world.decayInterval);
    const agentPaths = shortestPathsFrom(beliefs, beliefs.me.pos);

    for (let parcel of knownParcels) {
        if (!parcel.carriedBy) {
            const distanceToParcel = distanceFromSearch(agentPaths, parcel);
            if (!Number.isFinite(distanceToParcel)) continue;

            const parcelPaths = shortestPathsFrom(beliefs, parcel);
            const delivery = nearestReachableTarget(parcelPaths, beliefs.world.deliveries.values());
            if (!delivery) continue;

            const pickupCost = distanceToParcel + delivery.distance;
            const expectedNewParcelRewardAtDelivery = parcel.reward - (beliefs.world.decayFrequency() * pickupCost);
            if (expectedNewParcelRewardAtDelivery <= 0) continue;

            const utility = pickUpUtility(beliefs, parcel, distanceToParcel, delivery.distance);
            if (utility > 0) desires.push({ type: 'go_pick_up', target: { x: parcel.x, y: parcel.y }, utility, id: parcel.id });
        }
    }

    if (beliefs.parcels.carried.size > 0) {
        const delivery = nearestReachableTarget(agentPaths, beliefs.world.deliveries.values());
        if (delivery) {
            const utility = deliverUtility(beliefs, delivery.distance);
            if (utility > 0) desires.push({ type: 'go_deliver', target: { x: delivery.target.x, y: delivery.target.y }, utility });
        }
    }

    const hasPickupDesire = desires.some(desire => desire.type === 'go_pick_up');
    if (!hasPickupDesire && beliefs.parcels.carried.size === 0) {
        const outOfSightSpawners = Array.from(beliefs.world.spawners.values())
            .filter(spawner => distance(beliefs.me.pos, spawner) > beliefs.world.observationDistance);
        const spawner = nearestReachableTarget(agentPaths, outOfSightSpawners);
        if (spawner) {
            let utility = spawnerExplorationUtility(beliefs, spawner.distance);
            if (utility > 0) {
                desires.push({ type: 'go_to_spawner', target: { x: spawner.target.x, y: spawner.target.y }, utility });
            }
        }
    }

    return desires;
}
