import { distance } from "../utils/geometry.js";

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

const GO_DELIVER_THRESHOLD = 5;     // threshold to make the agent go deliver parcels if he has X * averageParcelReward parcels in its bag
const PARCEL_REWARD_THRESHOLD = 5;

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
 * @returns {number} the utility for picking up the parcel.
 */
export function pickUpUtility(beliefs, parcel) {
    let distanceToParcel = distance(beliefs.me.pos, parcel);
    let nearestDelivery = beliefs.world.nearestDelivery(beliefs.me.pos);
    let distanceToDelivery = distance(beliefs.me.pos, nearestDelivery);
    let decayFrequency = beliefs.world.decayFrequency();

    let expectedInfo = expectedUtilityInfo(beliefs, (distanceToParcel + distanceToDelivery));
    let expectedNumBaggedParcels = expectedInfo[0];
    let expectedBaggedReward = expectedInfo[1] - ((decayFrequency * distanceToParcel) * expectedNumBaggedParcels);
    let expectedParcelReward = parcel.reward - decayFrequency * distanceToParcel;
    let utility = (expectedParcelReward + expectedBaggedReward) - ((decayFrequency * distanceToDelivery) * (expectedNumBaggedParcels + 1));

    return utility;
}

/**
 * Computes the utility of delivering the carried parcels.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {number} the computed utility for delivering.
 */
export function deliverUtility(beliefs) {
    let nearestDelivery = beliefs.world.nearestDelivery(beliefs.me.pos);
    let distanceToDelivery = distance(beliefs.me.pos, nearestDelivery);

    let expectedInfo = expectedUtilityInfo(beliefs, distanceToDelivery);
    let expectedNumBaggedParcels = expectedInfo[0];
    let expectedBaggedReward = expectedInfo[1];

    let decayFrequency = beliefs.world.decayFrequency();
    let utility = expectedBaggedReward - ((decayFrequency * distanceToDelivery) * expectedNumBaggedParcels);

    return utility;
}

/**
 * Computes the exploration utility towards the nearest spawner.
 * Returns 0 when there is no out-of-sight spawner to explore or when the
 * expected reward is not positive.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {number} the exploration utility (0 if not worth exploring).
 */
export function spawnerExplorationUtility(beliefs) {
    let outOfSightSpawners = Array.from(beliefs.world.spawners.values())
        .filter(spawner => {
            return distance(beliefs.me.pos, spawner) > beliefs.world.observationDistance;
        });
    if (outOfSightSpawners.length === 0) return 0;    // 0 all other utilities should be positive, some testing needed to see if 0 is the right choice

    let nearestSpawner = beliefs.world.nearestSpawner(beliefs.me.pos);
    let distanceToSpawner = distance(beliefs.me.pos, nearestSpawner);
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

    for (let parcel of beliefs.parcels.visible.values()) {
        if (!parcel.carriedBy && parcel.reward > PARCEL_REWARD_THRESHOLD) {
            let utility = pickUpUtility(beliefs, parcel);
            if (utility > 0) desires.push({ type: 'go_pick_up', target: { x: parcel.x, y: parcel.y }, utility, id: parcel.id });
        }
    }

    if ((beliefs.parcels.carried.size > 0) && ((beliefs.world.decayFrequency() > 0) || (beliefs.parcels.carriedScore() > beliefs.world.avgReward * GO_DELIVER_THRESHOLD))) {
        let utility = deliverUtility(beliefs);
        if (utility > 0) {
            let deliveryPoint = beliefs.world.nearestDelivery(beliefs.me.pos);
            if (deliveryPoint) {   // guard: never emit a desire without a valid target
            desires.push({ type: 'go_deliver', target: { x: deliveryPoint.x, y: deliveryPoint.y }, utility });
            }
        }
    }

    if (beliefs.parcels.visible.size === 0 && beliefs.parcels.carried.size === 0) {
        let utility = spawnerExplorationUtility(beliefs);
        if (utility > 0) {
            let nearestSpawner = beliefs.world.nearestSpawner(beliefs.me.pos);
            desires.push({ type: 'go_to_spawner', target: { x: nearestSpawner.x, y: nearestSpawner.y }, utility });
        }
    }

    return desires;
}
