import { socket } from "../connection.js";
import { agentData, gameData } from "../Belief/Belief.js";
import { distance } from "../Belief/GameData.js";

const GO_DELIVER_THRESHOLD = 5;     // threshold to make the agent go deliver parcels if he has X * averageParcelReward parcels in its bag

async function optionGeneration(){
    agentData.options = [];

    /**
     * TODO: Might be useful to implement a class representing the option stack/array, may not be needed tho.
     * Chain of responsibility would be perfect for classes that need to operate differently depending on the option type.
     */

    for (let p of agentData.parcels.values()) {
        if (!p.carriedBy && p.reward > 5 ) {
            let utility = compute_pickup_utility(p);
            if (utility > 0) {
                agentData.options.push(['go_pick_up', p, utility]);
            }
        }
    }

    if ((agentData.baggedParcels.size > 0) || (gameData.getDecayFrequency() > 0) || (agentData.get_carried_score() > gameData.parcelAverageReward * GO_DELIVER_THRESHOLD)) {
        let deliveryInfo = compute_deliver_utility()
        agentData.options.push(['go_deliver', deliveryInfo[0].x, deliveryInfo[0].y, deliveryInfo[1]]);
    }

    if (agentData.parcels.size === 0 && agentData.baggedParcels.size === 0) {
        let explorationInfo = compute_nearest_spawner_exploration_utility();
        agentData.options.push(['go_to_spawner', explorationInfo[0].x, explorationInfo[0].y, explorationInfo[1]]);
    }
}

/**
 * 
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel} parcel 
 */
// TODO: Add edge case where parcel decay is disabled.
function compute_pickup_utility(parcel) {
    let numBaggedParcels = agentData.baggedParcels.size;
    let distanceToParcel = distance(agentData.pos, {x: parcel.x, y: parcel.y});
    
    let nearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
    let distanceToNearestDelivery = distance(agentData.pos, {x: nearestDelivery.x, y: nearestDelivery.y});
    
    
    let totalDistance = (distanceToParcel + distanceToNearestDelivery);
    let decayFrequency = gameData.getDecayFrequency();
    let baggedReward = agentData.get_carried_score();
    for (let baggedParcel of agentData.baggedParcels) {
        let expectedParcelReward = baggedParcel.reward - decayFrequency * totalDistance;

        if (expectedParcelReward <= 0) {
            numBaggedParcels --;
            baggedReward -= baggedParcel.reward;       
        }
    }

    let ExpectedParcelReward = parcel.reward - decayFrequency * distanceToParcel;
    let ExpectedBaggedReward = baggedReward - ((decayFrequency * distanceToParcel) * numBaggedParcels);
    let utility = (ExpectedParcelReward + ExpectedBaggedReward) - (decayFrequency * distanceToNearestDelivery) * (numBaggedParcels + 1);

    /**
     * TODO: Add a penalty to the utility if an enemy agent is close to the parcel
     */

    /** TODO: think about adding a malus to this utility in order to reduce the priority
     * that picking up a parcel would have over other actions.
     * It would prevent a case where the agent would keep picking up parcels but not actually deliver.
     */

    return utility;
}

function compute_deliver_utility() {
    let nearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
    let distanceToDelivery = distance(agentData.pos, nearestDelivery.x, nearestDelivery.y);
    
    let numBaggedParcels = agentData.baggedParcels.size;
    let baggedScore = agentData.get_carried_score();


    // TODO: might be a good idea to add a bonus to make this option more appetising
    let decayFrequency = gameData.getDecayFrequency();
    for (let parcel of agentData.baggedParcels.values()) {
        let ExpectedReward = parcel.reward - (decayFrequency * distanceToDelivery);
        if (ExpectedReward <= 0) {
            numBaggedParcels --;
            baggedScore -= parcel.reward;
        }
    }

    let utility = baggedScore - ((decayFrequency * distanceToDelivery) * numBaggedParcels);
    return [nearestDelivery, utility];
}

function compute_nearest_spawner_exploration_utility() {
    let outOfSightSpawners = Array.from(gameData.parcelSpawningMap)
        .filter( spawner => {
            return distance(agentData.pos, {x: spawner.x, y: spawner.y}) > gameData.observationDistance;
        })
        if (outOfSightSpawners.size === 0) return 0;    // 0 all other utilities should be positive, some testing needed to see if 0 is the right choice

        let nearestSpawner = gameData.getNearestSpawningPoint(agentData.pos);
        let distanceToSpawner = distance(agentData.pos, nearestSpawner);
        let decayFrequency = gameData.getDecayFrequency();

        let expectedReward = (gameData.parcelAverageReward - (distanceToSpawner * decayFrequency));
        if (expectedReward <= 0) return 0;

        // TODO: might be useful to add a malus here.
        let utility = (expectedReward) / distanceToSpawner;
        return [nearestSpawner, utility];
        
}

export {optionGeneration}