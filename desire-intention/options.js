import { socket } from "../connection.js";
import { agentData, gameData } from "../belief/Belief.js";
import { distance } from "../utils/geometry.js";

const GO_DELIVER_THRESHOLD = 5;     // threshold to make the agent go deliver parcels if he has X * averageParcelReward parcels in its bag
const PARCEL_REWARD_THRESHOLD = 5;

async function optionGeneration(){
    agentData.options = []; // TODO: think about this

    /**
     * TODO: Might be useful to implement a class representing the option stack/array, may not be needed tho.
     * Chain of responsibility would be perfect for classes that need to operate differently depending on the option type.
     */

    for (let parcel of agentData.parcels.values()) {
        if (!parcel.carriedBy && parcel.reward > PARCEL_REWARD_THRESHOLD) generatePickUpOption(parcel);
    }

    if ((agentData.baggedParcels.size > 0) && ( (gameData.getDecayFrequency() > 0) || (agentData.getCarriedScore() > gameData.parcelAverageReward * GO_DELIVER_THRESHOLD) )) {
        generateDeliveryOption();
    }

    if (agentData.parcels.size === 0 && agentData.baggedParcels.size === 0) {
        let explorationInfo = computeNearestSpawnerExplorationUtility();
        if (explorationInfo[0] !== null) {
            agentData.options.push(['go_to_spawner', explorationInfo[0].x, explorationInfo[0].y, explorationInfo[1]]);
        }
    }
}

/**
 * This function generates and pushes a go_pick_up option given a parcel on the ground.
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel} parcel 
 */
function generatePickUpOption(parcel) {
    let utility = computePickupUtility(parcel);
    if (utility > 0) {
        agentData.options.push(['go_pick_up', parcel, utility]);
    }
}

/**
 * This function generates and pushes a go_deliver option for the agent.
 */
function generateDeliveryOption() {
    let utility = computeDeliverUtility()
    let deliveryTile = gameData.getNearestDeliveryPoint(agentData.pos);
    agentData.options.push(['go_deliver', deliveryTile, utility]);
}
 
/**
 * This function computes the expected values for the number of carried parcels and of the bagged reward.
 * For each parcel in the agent's bag we compute its expected reward using a given distance.
 * If it's lte than 0, we count one less bagged parcel and remove its reward, in order to be able to compute a more precise utility value.
 * @param {number} distance 
 * @returns 
 */
function computeExpectedUtilityInfo(distance) {
    let expectedNumBaggedParcels = agentData.baggedParcels.size;
    let expectedBaggedReward = agentData.getCarriedScore();
    let decayFrequency = gameData.getDecayFrequency();
    for (let baggedParcel of agentData.baggedParcels.values()) {
        let expectedParcelReward = baggedParcel.reward - (decayFrequency * distance);
        console.log("decay freq: ",decayFrequency);
        if (expectedParcelReward <= 0) {
            expectedNumBaggedParcels --;
            expectedBaggedReward -= baggedParcel.reward;
        }
    }
    return [expectedNumBaggedParcels, expectedBaggedReward];
}

/**
 * This function computes the utility value for picking up a given parcel that is on the gorund.
 * We take into account the agent's position, the parcel's position and
 * the nearest delivery point's position.
 * Future version will include a malus to make the option less unbalanced compared to others.
 * Also, future version will add a penalty for agents close to the parcel.
 * 
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel} parcel 
 * @returns {number} the utility value for picking up the given parcel
 */
function computePickupUtility(parcel) {
    let distanceToParcel = distance(agentData.pos, {x: parcel.x, y: parcel.y});
    let nearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
    let distanceToDelivery = distance(agentData.pos, {x: nearestDelivery.x, y: nearestDelivery.y});
    let decayFrequency = gameData.getDecayFrequency();

    let expectedInfo = computeExpectedUtilityInfo((distanceToParcel + distanceToDelivery));
    let expectedNumBaggedParcels = expectedInfo[0];
    let expectedBaggedReward = expectedInfo[1] - ((decayFrequency * distanceToParcel) * expectedNumBaggedParcels);

    let expectedParcelReward = parcel.reward - decayFrequency * distanceToParcel;
    let utility = (expectedParcelReward + expectedBaggedReward) - ( (decayFrequency * distanceToDelivery) * (expectedNumBaggedParcels + 1) );

    // TODO: add a penalty to the utility if an aenemy agent is close to the parcel.

    /** TODO: think about adding a malus to this utility in order to reduce the priority that picking up a parcel would have over other actions.
     * It would prevent a case where the agent would keep picking up parcels but not actually deliver.
     */
    
    return utility;
}

/**
 * This function computes the nearest delivery point and the delivery
 * @returns the utility value for delivering the bagged parcels.
 */
function computeDeliverUtility() {
    let nearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
    let distanceToDelivery = distance(agentData.pos, {x: nearestDelivery.x, y: nearestDelivery.y});
    
    let expectedInfo = computeExpectedUtilityInfo(distanceToDelivery);
    let expectedNumBaggedParcels = expectedInfo[0];
    let expectedBaggedReward = expectedInfo[1];

    let decayFrequency = gameData.getDecayFrequency();
    let utility = expectedBaggedReward - ((decayFrequency * distanceToDelivery) * expectedNumBaggedParcels);
    // TODO: adding a bonus multiplier to this utility might be a good idea to make delivery more appetising.
    return utility;
}

function computeNearestSpawnerExplorationUtility() {
    let outOfSightSpawners = Array.from(gameData.parcelSpawningMap.values())
        .filter( spawner => {
            return distance(agentData.pos, {x: spawner.x, y: spawner.y}) > gameData.observationDistance;
        })
        if (outOfSightSpawners.length === 0) return [null, 0];    // 0 all other utilities should be positive, some testing needed to see if 0 is the right choice

        let nearestSpawner = gameData.getNearestSpawningPoint(agentData.pos);
        let distanceToSpawner = distance(agentData.pos, nearestSpawner);
        let decayFrequency = gameData.getDecayFrequency();

        let expectedReward = (gameData.parcelAverageReward - (distanceToSpawner * decayFrequency));
        if (expectedReward <= 0) return [null, 0];

        // TODO: might be useful to add a malus here.
        let utility = (expectedReward) / distanceToSpawner;
        return [nearestSpawner, utility];
        
}

export {optionGeneration, computePickupUtility ,computeNearestSpawnerExplorationUtility, computeDeliverUtility} // Once everything is tested, it's likely that only optionGeneration will need to be exported