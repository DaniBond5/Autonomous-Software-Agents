import { distanceFromSearch, shortestPathsFrom } from "../utils/geometry.js";

/**
 * @typedef {{x: number, y: number}} Point
 */

/**
 * @typedef {Object} Desire
 * @property {'go_pick_up'|'go_deliver'|'go_to_spawner'|'go_to_tile'|'pick_up_here'|'put_down_here'|'handoff'} type
 * @property {Point} [target]
 * @property {number} utility
 * @property {number} [distance]
 * @property {string} [id]
 * @property {string} [objectiveId]
 * @property {'pickup'|'drop'|'exit'|'wait'|'deliver'} [phase]
 */

// Desires are rebuilt each cycle, so their keys preserve goal identity.
export function desireKey(desire) {
    if (desire.objectiveId) {
        const x = desire.target?.x ?? "";
        const y = desire.target?.y ?? "";
        return `external:${desire.objectiveId}:${desire.phase ?? ""}:${x},${y}`;
    }
    return `${desire.type}:${desire.id ?? ''}:${desire.target.x},${desire.target.y}`;
}

// Prefer operational or explicitly allowed deliveries, with all reachable ones as fallback.
export function preferOperationalDeliveryCandidates(beliefs, candidates) {
    const safe = candidates.filter(candidate =>
        candidate.delivery.canReachOperationalSpawner === true
        || beliefs.rules.includesDeliveryTile(candidate.delivery)
    );
    return safe.length > 0 ? safe : candidates;
}

/**
 * Estimates the carried reward after the moves needed to reach a delivery.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {number} distanceToDelivery
 * @returns {number}
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
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} batch
 * @param {number} totalDistance
 * @returns {number}
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
 * Scores a delivery by expected ruled reward per movement.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {number} distanceToDelivery
 * @param {Point} deliveryTile
 * @returns {number}
 */
function deliverUtility(beliefs, distanceToDelivery, deliveryTile) {
    const expectedDeliveredReward = expectedCarriedRewardAtDelivery(beliefs, distanceToDelivery);

    const expectedRuledReward = expectedDeliveredReward
        * beliefs.rules.stackMultiplier(beliefs.parcels.carried.size)
        * beliefs.rules.deliveryMultiplier(deliveryTile);

    return expectedRuledReward / Math.max(1, distanceToDelivery);
}

/** @returns {number} priority from staleness divided by path distance */
function spawnerExplorationUtility(movesSinceCheck, pathDistance) {
    return movesSinceCheck / Math.max(1, pathDistance);
}

/**
 * Regenerates autonomous desires and prepends the active external objective.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {import("./objectives.js").ObjectiveStore | null} [objectives=null]
 * @returns {Desire[]}
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

        // Both agents use the same distance comparison, so exactly one yields a claimed parcel.
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
    // Explore as a fallback; on one-way maps moving can expose new reachable goals.
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

    const externalObjective = objectives?.activeDesire() ?? null;
    return externalObjective
        ? [externalObjective, ...desires]
        : desires;
}
