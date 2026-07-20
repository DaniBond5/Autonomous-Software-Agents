import { distanceFromSearch, shortestPathsFrom } from "../utils/geometry.js";

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
 * Computes the total reward that carried parcels are expected to retain at delivery.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {number} distanceToDelivery
 * @returns {number} the expected carried reward at delivery
 */
function expectedCarriedRewardAtDelivery(beliefs, distanceToDelivery) {
    const decayPerMove = beliefs.world.decayPerMove();
    let expectedReward = 0;

    for (const parcel of beliefs.parcels.carried.values()) {
        expectedReward += Math.max(
            0,
            parcel.reward - decayPerMove * distanceToDelivery
        );
    }

    return expectedReward;
}

/**
 * Computes the utility of picking up the given parcel.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {number} pickupCost
 * @param {number} expectedNewParcelReward
 * @returns {number} the path-efficiency utility for picking up the parcel.
 */
function pickUpUtility(beliefs, pickupCost, expectedNewParcelReward) {
    const expectedCarriedReward = expectedCarriedRewardAtDelivery(beliefs, pickupCost);
    const expectedTotalDeliveredReward = expectedCarriedReward + expectedNewParcelReward;

    return expectedTotalDeliveredReward / Math.max(1, pickupCost);
}

/**
 * Computes the utility of delivering the carried parcels.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {number} distanceToDelivery
 * @returns {number} the path-efficiency utility for delivering.
 */
function deliverUtility(beliefs, distanceToDelivery) {
    const expectedDeliveredReward = expectedCarriedRewardAtDelivery(beliefs, distanceToDelivery);

    return expectedDeliveredReward / Math.max(1, distanceToDelivery);
}

/**
 * movesSinceCheck = 1 + (now - lastCheckedAt) / movementDuration
 * explorationUtility = movesSinceCheck / max(1, pathDistance)
 * Spawners not observed recently gain priority over time, while BFS distance penalizes costly trips.
 * @param {number} movesSinceCheck
 * @param {number} pathDistance
 * @returns {number} the exploration utility
 */
function spawnerExplorationUtility(movesSinceCheck, pathDistance) {
    return movesSinceCheck / Math.max(1, pathDistance);
}

/**
 * Generates the current set of desires as plain objects, given the beliefs.
 * Desires are ephemeral data, regenerated every cycle.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {Desire[]} the generated desires.
 */
export function generateDesires(beliefs) {
    const desires = [];
    const knownParcels = beliefs.parcels.availableKnown(beliefs.world.localDecayIntervalMs);
    const agentPaths = shortestPathsFrom(beliefs, beliefs.me.pos);

    for (const parcel of knownParcels) {
        const distanceToParcel = distanceFromSearch(agentPaths, parcel);
        if (!Number.isFinite(distanceToParcel)) continue;

        const parcelPaths = shortestPathsFrom(beliefs, parcel);
        const delivery = nearestReachableTarget(parcelPaths, beliefs.world.deliveries.values());
        if (!delivery) continue;

        const pickupCost = distanceToParcel + delivery.distance;
        const expectedNewParcelRewardAtDelivery = Math.max(
            0,
            parcel.reward - beliefs.world.decayPerMove() * pickupCost
        );
        if (expectedNewParcelRewardAtDelivery <= 0) continue;

        const utility = pickUpUtility(
            beliefs,
            pickupCost,
            expectedNewParcelRewardAtDelivery
        );
        if (utility > 0) desires.push({ type: 'go_pick_up', target: { x: parcel.x, y: parcel.y }, utility, id: parcel.id });
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
        const now = Date.now();
        const movementDuration = Math.max(1, beliefs.world.movementDuration);
        let bestSpawner = null;
        let bestPathDistance = Infinity;
        let bestUtility = -Infinity;

        for (const spawner of beliefs.world.spawners.values()) {
            if (beliefs.world.isVisible(spawner)) continue;

            const pathDistance = distanceFromSearch(agentPaths, spawner);
            if (!Number.isFinite(pathDistance)) continue;

            const lastCheckedAt = spawner.lastCheckedAt ?? now;
            const timeSinceCheck = Math.max(0, now - lastCheckedAt);
            const movesSinceCheck = 1 + timeSinceCheck / movementDuration;
            const explorationUtility = spawnerExplorationUtility(movesSinceCheck, pathDistance);

            if (explorationUtility > bestUtility
                || (explorationUtility === bestUtility && pathDistance < bestPathDistance)) {
                bestSpawner = spawner;
                bestPathDistance = pathDistance;
                bestUtility = explorationUtility;
            }
        }

        if (bestSpawner) {
            desires.push({
                type: 'go_to_spawner',
                target: { x: bestSpawner.x, y: bestSpawner.y },
                utility: bestUtility,
            });
        }
    }

    return desires;
}
