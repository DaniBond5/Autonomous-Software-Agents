import { distanceFromSearch, shortestPathsFrom } from "../utils/geometry.js";

/**
 * @typedef {{x: number, y: number}} Point
 */

/**
 * A desire is a candidate goal the agent could pursue. Navigation variants
 * expose a target, while action objectives operate on the current tile.
 *
 * @typedef {Object} Desire
 * @property {'go_pick_up'|'go_deliver'|'go_to_spawner'|'go_to_tile'|'pick_up_here'|'put_down_here'} type
 * @property {Point} [target]  - where to move, when the desire navigates
 * @property {number} utility  - score from the utility functions
 * @property {number} [distance] - current BFS distance from the agent to the target
 * @property {string} [id]     - parcel id, ONLY for go_pick_up (used for intention revision)
 * @property {string} [objectiveId] - explicit objective identity, only for external goals
 */

/**
 * Builds the identity of a desire. Desire objects are rebuilt from scratch on
 * every cycle, so a goal can only be recognised across cycles through this key.
 * @param {Desire} desire
 * @returns {string} the desire identity
 */
export function desireKey(desire) {
    if (desire.objectiveId) {
        return `objective:${desire.type}:${desire.objectiveId}`;
    }
    return `${desire.type}:${desire.id ?? ''}:${desire.target.x},${desire.target.y}`;
}

/**
 * Keeps delivery tiles that are operational or explicitly allowed by a policy.
 * If none are safe, every reachable candidate remains available as a fallback.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {object[]} candidates
 * @returns {object[]} safe candidates when possible, or all candidates as a fallback.
 */
function preferOperationalDeliveryCandidates(beliefs, candidates) {
    // A policy can explicitly allow one delivery tile.
    // Other unsafe delivery tiles remain excluded.
    const safe = candidates.filter(candidate =>
        candidate.delivery.canReachOperationalSpawner === true
        || beliefs.rules.includesDeliveryTile(candidate.delivery)
    );
    return safe.length > 0 ? safe : candidates;
}

/**
 * This function computes the total reward that carried parcels are expected to retain
 * if the agent were to move to a delivery tile with the given distance.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {number} distanceToDelivery
 * @returns {number} the expected carried reward at a delivery tile with the given distance from it.
 */
function expectedCarriedRewardAtDelivery(beliefs, distanceToDelivery) {
    const decayPerMove = beliefs.world.decayPerMove();
    let expectedReward = 0;

    for (const parcel of beliefs.parcels.carried.values()) {
        const decayed = Math.max(
            0,
            parcel.reward - decayPerMove * distanceToDelivery
        );
        expectedReward += decayed * beliefs.rules.parcelMultiplier(parcel.reward);
    }

    return expectedReward;
}

/**
 * Computes the reward a batch on one tile would retain at a delivery.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} batch
 * @param {number} totalDistance
 */
function expectedBatchRewardAtDelivery(beliefs, batch, totalDistance) {
    const decayPerMove = beliefs.world.decayPerMove();
    let reward = 0;
    for (const parcel of batch) {
        const decayed = Math.max(0, parcel.reward - decayPerMove * totalDistance);
        reward += decayed * beliefs.rules.parcelMultiplier(parcel.reward);
    }
    return reward;
}

/**
 * Chooses the future delivery that gives one pickup batch its best expected utility.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("../utils/geometry.js").ShortestPaths | null} parcelPaths
 * @param {number} distanceToParcel
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} batch
 * @returns {{delivery:Point,utility:number}|null}
 */
function bestDeliveryAfterPickup(beliefs, parcelPaths, distanceToParcel, batch) {
    const projectedCount = beliefs.parcels.carried.size + batch.length;
    const candidates = [];

    for (const delivery of beliefs.world.deliveries.values()) {
        const distanceAfterPickup = distanceFromSearch(parcelPaths, delivery);
        if (!Number.isFinite(distanceAfterPickup)) continue;

        const totalDistance = distanceToParcel + distanceAfterPickup;
        const newReward = expectedBatchRewardAtDelivery(
            beliefs,
            batch,
            totalDistance
        );
        const carriedReward = expectedCarriedRewardAtDelivery(
            beliefs,
            totalDistance
        );
        const adjustedReward = (carriedReward + newReward)
            * beliefs.rules.stackMultiplier(projectedCount)
            * beliefs.rules.deliveryMultiplier(delivery);
        // A zero-value parcel can still complete an exact stack.
        // Keep it only when the full delivery has positive value.
        if (adjustedReward <= 0) continue;

        candidates.push({
            delivery,
            utility: adjustedReward / Math.max(1, totalDistance)
        });
    }

    let best = null;
    for (const candidate of preferOperationalDeliveryCandidates(beliefs, candidates)) {
        if (candidate.utility > (best?.utility ?? 0)) best = candidate;
    }
    return best;
}

/**
 * This function computes the utility of delivering the carried parcels.
 * The utility is computed by using the distance to the nearest delivery tile.
 * @todo add formula in comments
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {number} distanceToDelivery
 * @param {Point} deliveryTile the tile being scored, since a policy can single one out
 * @returns {number} the path-efficiency utility for delivering.
 */
function deliverUtility(beliefs, distanceToDelivery, deliveryTile) {
    const expectedDeliveredReward = expectedCarriedRewardAtDelivery(beliefs, distanceToDelivery);

    const expectedRuledReward = expectedDeliveredReward
        * beliefs.rules.stackMultiplier(beliefs.parcels.carried.size)
        * beliefs.rules.deliveryMultiplier(deliveryTile);

    return expectedRuledReward / Math.max(1, distanceToDelivery);
}

/**
 * This function computes the utlity for the action of exploring, typically used when there's no other option.
 * This utility is computed with the amount of moves since the last time a spawner was checked and the distance to reach it.
 * Spawners not observed recently gain priority over time, while BFS distance penalizes costly trips.
 * @param {number} movesSinceCheck
 * @param {number} pathDistance
 * @returns {number} the exploration utility
 */
function spawnerExplorationUtility(movesSinceCheck, pathDistance) {
    return movesSinceCheck / Math.max(1, pathDistance);
}

/**
 * This function generates the current set of desires as plain objects, given the beliefs.
 * Desires are ephemeral data, regenerated every cycle.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("./objectives.js").ObjectiveStore | null} [objectives=null]
 * @returns {Desire[]} the generated desires.
 */
export function generateDesires(beliefs, objectives = null) {
    const desires = [];
    const knownParcels = beliefs.parcels.availableKnown(beliefs.world.localDecayIntervalMs);
    const agentPaths = shortestPathsFrom(beliefs, beliefs.me.pos);
    const batches = new Map();
    for (const parcel of knownParcels) {
        const key = `${parcel.x},${parcel.y}`;
        const batch = batches.get(key) ?? [];
        batch.push(parcel);
        batches.set(key, batch);
    }
    const pickupTiles = new Set();

    for (const parcel of knownParcels) {
        const parcelKey = `${parcel.x},${parcel.y}`;
        if (pickupTiles.has(parcelKey)) continue;
        const batch = batches.get(parcelKey);
        if (!beliefs.rules.canPickUpBatch(
            beliefs.parcels.carried.size,
            batch.length
        )) continue;

        const distanceToParcel = distanceFromSearch(agentPaths, parcel);
        if (!Number.isFinite(distanceToParcel)) continue;

        // Leave a claimed parcel to the partner when the partner is closer to it. Yielding is symmetric:
        // both agents weigh the same two distances, so exactly one of them drops the parcel from its
        // desires and the other one keeps it. The check sits here because it needs the distance above.
        if (beliefs.partner.outbidsMeOn(parcel.id, distanceToParcel, beliefs.me.id)) continue;

        const parcelPaths = shortestPathsFrom(beliefs, parcel);
        const delivery = bestDeliveryAfterPickup(
            beliefs,
            parcelPaths,
            distanceToParcel,
            batch
        );
        if (!delivery) continue;

        if (delivery.utility > 0) {
            pickupTiles.add(parcelKey);
            desires.push({
                type: 'go_pick_up',
                target: { x: parcel.x, y: parcel.y },
                utility: delivery.utility,
                distance: distanceToParcel,
                id: parcel.id
            });
        }
    }

    if (beliefs.parcels.carried.size > 0
        && beliefs.rules.canDeliverStack(beliefs.parcels.carried.size)) {
        const deliveryCandidates = [];
        for (const delivery of beliefs.world.deliveries.values()) {
            const distanceToDelivery = distanceFromSearch(agentPaths, delivery);
            if (!Number.isFinite(distanceToDelivery)) continue;

            const utility = deliverUtility(beliefs, distanceToDelivery, delivery);
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
            beliefs,
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

    // A goal a mission asked for. It is added outside the exploration branch above because it
    // holds whatever else the agent has to do, and it competes on utility like anything else.
    desires.push(...beliefs.rules.injectedDesires());

    // The BDI loop reads the objective published by the LLM as a normal desire.
    const objectiveDesire = objectives?.getActiveDesire();
    if (objectiveDesire) desires.push(objectiveDesire);

    return desires;
}
