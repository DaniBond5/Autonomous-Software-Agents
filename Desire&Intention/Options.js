import { socket } from "../connection";
import { agentData, gameData } from "../Belief/Belief";
import { distance } from "../Belief/GameData";

const GO_DELIVER_THRESHOLD = 5;     // threshold to make the agent go deliver parcels if he has X * averageParcelReward parcels in its bag

async function optionGeneration(){
    agentData.options = [];

    /**
     * TODO: A great idea would be to create a class representing the Option array, a chain
     * of responsibility would be the go to IMO
     */

    for (let p of agentData.parcels.values()) {
        if (!p.carriedBy && p.reward > 5 ) {
            let utility = compute_pickup_utility(p);
            if (utility > 0) {
                agentData.options.push(['go_pick_up', p.x, p.y, p.id, utility]);
            }
        }
    }

    if (gameData.decayFrequency > 0 || (agentData.get_carried_score() > gameData.parcelAverageReward * GO_DELIVER_THRESHOLD)) {
        let deliveryInfo = compute_deliver_utility()
        agentData.options.push(['go_deliver', deliveryInfo[0].x, deliveryInfo[0].y, deliveryInfo[1]]);
    }
}

/**
 * 
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel} parcel 
 */
// TODO: Add edge case where parcel decay is disabled.
function compute_pickup_utility(parcel) {
    let numBaggedParcels = agentData.baggedParcels.size();
    let distanceToParcel = distance(agentData.pos, parcel.x, parcel.y );
    
    let nearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
    let distanceToNearestDelivery = distance(agentData.pos, nearestDelivery.x, nearestDelivery.y);
    
    
    let totalDistance = (distanceToParcel + distanceToNearestDelivery);
    let decayFrequency = gameData.getDecayFrequency();
    let baggedReward = agentData.get_carried_score();
    for (baggedParcel of agentData.baggedParcels) {
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

    for (let parcel of agentData.baggedParcels.values()) {
        let decayFrequency = gameData.getDecayFrequency();
        let ExpectedReward = parcel.reward - (decayFrequency * distanceToDelivery);
        if (ExpectedReward <= 0) {
            numBaggedParcels --;
            baggedScore -= parcel.reward;
        }
    }

    let utility = baggedScore - ((decayFrequency * distanceToDelivery) * numBaggedParcels);

    return [nearestDelivery, utility];
}