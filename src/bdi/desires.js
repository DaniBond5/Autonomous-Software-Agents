import { distanceFromSearch, shortestPathsFrom } from "../utils/geometry.js";

/**
 * @typedef {{x: number, y: number}} Point
 */

/**
 * A desire is a candidate goal the agent could pursue. All variants expose a
 * `target`, so intention handling remains independent of the desire type.
 * The terminal action (pickup / putdown / nothing) is dispatched on `type`.
 *
 * @typedef {Object} Desire
 * @property {'go_pick_up'|'go_deliver'|'go_to_spawner'} type
 * @property {Point}  target   - where to move
 * @property {number} utility  - score from the utility functions
 * @property {number} [distance] - current BFS distance from the agent to the target
 * @property {string} [id]     - parcel id, ONLY for go_pick_up (used for intention revision)
 */

/**
 * Builds the identity of a desire. Desire objects are rebuilt from scratch on
 * every cycle, so a goal can only be recognised across cycles through this key.
 * @param {Desire} desire
 * @returns {string} the desire identity
 */
export function desireKey(desire) {
    return `${desire.type}:${desire.id ?? ''}:${desire.target.x},${desire.target.y}`;
}

/**
 * Prefers operational delivery candidates when at least one is available.
 */
function preferOperationalDeliveryCandidates(candidates) {
    const operational = candidates.filter(candidate =>
        candidate.delivery.canReachOperationalSpawner === true
    );
    return operational.length > 0 ? operational : candidates;
}

/**
 * Selects the preferred reachable delivery with the shortest path.
 * @param {import("../utils/geometry.js").ShortestPaths | null} search
 * @param {Iterable<Point>} deliveries
 * @returns {{delivery: Point, distance: number} | null}
 */
function nearestReachableDelivery(search, deliveries) {
    const candidates = [];
    for (const delivery of deliveries) {
        const distance = distanceFromSearch(search, delivery);
        if (Number.isFinite(distance)) {
            candidates.push({ delivery, distance });
        }
    }

    let nearest = null;
    for (const candidate of preferOperationalDeliveryCandidates(candidates)) {
        if (candidate.distance < (nearest?.distance ?? Infinity)) {
            nearest = candidate;
        }
    }

    return nearest;
}

/**
 * Computes the total reward that carried parcels are expected to retain at delivery.
 * @param {import("./beliefs.js").Beliefs} beliefs
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
 * @param {import("./beliefs.js").Beliefs} beliefs
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
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {number} distanceToDelivery
 * @returns {number} the path-efficiency utility for delivering.
 */
function deliverUtility(beliefs, distanceToDelivery) {
    const expectedDeliveredReward = expectedCarriedRewardAtDelivery(beliefs, distanceToDelivery);

    return expectedDeliveredReward / Math.max(1, distanceToDelivery);
}

/**
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
 * @param {import("./beliefs.js").Beliefs} beliefs
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
        const delivery = nearestReachableDelivery(
            parcelPaths,
            beliefs.world.deliveries.values()
        );
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
        if (utility > 0) {
            desires.push({
                type: 'go_pick_up',
                target: { x: parcel.x, y: parcel.y },
                utility,
                distance: distanceToParcel,
                id: parcel.id
            });
        }
    }

    if (beliefs.parcels.carried.size > 0) {
        const deliveryCandidates = [];
        for (const delivery of beliefs.world.deliveries.values()) {
            const distanceToDelivery = distanceFromSearch(agentPaths, delivery);
            if (!Number.isFinite(distanceToDelivery)) continue;

            const utility = deliverUtility(beliefs, distanceToDelivery);
            if (utility > 0) {
                deliveryCandidates.push({
                    delivery,
                    desire: {
                        type: 'go_deliver',
                        target: { x: delivery.x, y: delivery.y },
                        utility,
                        distance: distanceToDelivery,
                    }
                });
            }
        }
        for (const candidate of preferOperationalDeliveryCandidates(
            deliveryCandidates
        )) {
            desires.push(candidate.desire);
        }
    }

    const hasPickupDesire = desires.some(desire => desire.type === 'go_pick_up');
    // Explore when there is nothing better to do. The carried check normally
    // keeps the agent from wandering off with parcels in hand, but it is lifted
    // when the set would otherwise be empty: with no desire at all the intention
    // stays null and the agent stops for good, and moving is the only thing that
    // changes which tiles are reachable on a one-way map.
    if (!hasPickupDesire
        && (beliefs.parcels.carried.size === 0 || desires.length === 0)) {
        const now = Date.now();
        const movementDuration = Math.max(1, beliefs.world.movementDuration);

        for (const spawner of beliefs.world.spawners.values()) {
            if (beliefs.world.isVisible(spawner)) continue;
            if (spawner.canReachOperationalDelivery !== true) continue;

            const pathDistance = distanceFromSearch(agentPaths, spawner);
            if (!Number.isFinite(pathDistance)) continue;

            const lastCheckedAt = spawner.lastCheckedAt ?? now;
            const timeSinceCheck = Math.max(0, now - lastCheckedAt);
            const movesSinceCheck = 1 + timeSinceCheck / movementDuration;
            desires.push({
                type: 'go_to_spawner',
                target: { x: spawner.x, y: spawner.y },
                utility: spawnerExplorationUtility(movesSinceCheck, pathDistance),
            });
        }
    }

    return desires;
}
