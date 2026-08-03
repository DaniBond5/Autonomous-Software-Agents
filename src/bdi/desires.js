import { distanceFromSearch, shortestPathsFrom } from "../utils/geometry.js";

/**
 * @typedef {{x: number, y: number}} Point
 */

/**
 * A desire is a candidate goal the agent could pursue. All variants expose a
 * `target`, so intention handling remains independent of the desire type.
 * The terminal action (pickup / putdown / nothing) is defined with `type`.
 *
 * @typedef {Object} Desire
 * @property {'go_pick_up'|'go_deliver'|'go_to_spawner'|'go_to_tile'} type
 * @property {Point}  target   - where to move
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
    const identity = desire.objectiveId ?? desire.id ?? '';
    return `${desire.type}:${identity}:${desire.target.x},${desire.target.y}`;
}

/**
 * This function returns an array of the delivery tiles present in the map.
 * It gives priority to operational delivery tiles, for the definition of operational tiles refer to the comments in Beliefs.
 * If at least one operational delivery tile is present, an array containing them is returned.
 * If none are present, all delivery tiles are returned. 
 * @param {import ("@unitn-asa/deliveroo-js-sdk").IOTile[]} candidates 
 * @returns {import ("@unitn-asa/deliveroo-js-sdk").IOTile[]} an array of only the operational delivery tiles if present, all delivery tiles otherwise.
 */
function preferOperationalDeliveryCandidates(candidates) {
    const operational = candidates.filter(candidate =>
        candidate.delivery.canReachOperationalSpawner === true
    );
    return operational.length > 0 ? operational : candidates;
}

/**
 * This function returns the nearest delivery tile given a search and all delivery tiles.
 * Priority is given to operational delivery tiles, so if at least one is present, the nearest delivery tile is computed among them,
 * otherwise it's computed through all delivery tiles.
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
        // The one place a carried parcel is weighed against a value rule. Both utilities
        // below reach this function, so applying the rule in either of them as well would
        // square the multiplier.
        const value = beliefs.rules.parcelValueEffect(parcel.reward);
        expectedReward += Math.max(0, decayed * value.multiplier + value.additive);
    }

    return expectedReward;
}

/**
 * This function computes the utility of picking up the given parcel.
 * The utility is computed by using both the distance to the parcel and the distance to the nearest delivery tile.
 * @todo Add formula in comments.
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {number} pickupCost
 * @param {number} expectedNewParcelReward
 * @param {number} parcelReward the parcel's own reward, which is what a value rule is matched on
 * @returns {number} the path-efficiency utility for picking up the parcel.
 */
function pickUpUtility(beliefs, pickupCost, expectedNewParcelReward, parcelReward) {
    const expectedCarriedReward = expectedCarriedRewardAtDelivery(beliefs, pickupCost);
    const value = beliefs.rules.parcelValueEffect(parcelReward);
    const expectedNewReward = Math.max(
        0,
        expectedNewParcelReward * value.multiplier + value.additive
    );

    // The stack rule is weighed at the count the agent would be carrying with this parcel in
    // hand, not the count it carries now. A bonus for stacks of three has to make the first and
    // the second pickup worth more, and at the current count it never would: the agent would
    // take one parcel, find the delivery already worth walking to, and deliver it alone.
    const stack = beliefs.rules.stackEffect(beliefs.parcels.carried.size + 1);
    const expectedTotalDeliveredReward =
        (expectedCarriedReward + expectedNewReward) * stack.multiplier + stack.additive;

    return expectedTotalDeliveredReward / Math.max(1, pickupCost);
}

/**
 * This function computes the utility of delivering the carried parcels.
 * The utility is computed by using the distance to the nearest delivery tile.
 * @todo add formula in comments
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {number} distanceToDelivery
 * @param {Point} deliveryTile the tile being scored, since a rule can single one out
 * @returns {number} the path-efficiency utility for delivering.
 */
function deliverUtility(beliefs, distanceToDelivery, deliveryTile) {
    const expectedDeliveredReward = expectedCarriedRewardAtDelivery(beliefs, distanceToDelivery);

    // Here the stack rule is weighed at the count actually in hand: this is the delivery that
    // would happen now. Both effects land on the expected reward and not on the finished
    // utility, because every utility here is a rate and scaling a rate would make desires of
    // different types incomparable.
    const stack = beliefs.rules.stackEffect(beliefs.parcels.carried.size);
    const tile = beliefs.rules.deliveryTileEffect(deliveryTile);
    const expectedRuledReward =
        (expectedDeliveredReward * stack.multiplier + stack.additive)
        * tile.multiplier + tile.additive;

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
 * @param {boolean} [ignoreAvoided=false] set by the retry at the bottom of this function
 * @param {import("./objectives.js").ObjectiveStore | null} [objectives=null]
 * @returns {Desire[]} the generated desires.
 */
export function generateDesires(beliefs, ignoreAvoided = false, objectives = null) {
    const desires = [];
    const knownParcels = beliefs.parcels.availableKnown(beliefs.world.localDecayIntervalMs);
    const agentPaths = shortestPathsFrom(beliefs, beliefs.me.pos, { ignoreAvoided });

    for (const parcel of knownParcels) {
        const distanceToParcel = distanceFromSearch(agentPaths, parcel);
        if (!Number.isFinite(distanceToParcel)) continue;

        // Leave a claimed parcel to the partner when the partner is closer to it. Yielding is symmetric:
        // both agents weigh the same two distances, so exactly one of them drops the parcel from its
        // desires and the other one keeps it. The check sits here because it needs the distance above.
        if (beliefs.partner.outbidsMeOn(parcel.id, distanceToParcel, beliefs.me.id)) continue;

        const parcelPaths = shortestPathsFrom(beliefs, parcel, { ignoreAvoided });
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
            expectedNewParcelRewardAtDelivery,
            parcel.reward
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

    // An avoided tile is a hard exclusion in the search, and one tile in a corridor can cut the
    // map in two and leave the agent with nothing reachable and nothing to want. Rather than
    // stand still, plan the cycle again with the avoidance lifted: when the only route crosses
    // the tile the agent crosses it, which is the call a soft penalty would arrive at anyway.
    // One retry only, since the flag is set on the way in.
    if (desires.length === 0 && !ignoreAvoided && beliefs.rules.hasAvoided) {
        return generateDesires(beliefs, true, objectives);
    }

    return desires;
}
