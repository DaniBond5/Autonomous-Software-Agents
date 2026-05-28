import { socket } from "../connection";
import { agentData, gameData } from "../Belief/Belief";
import { distance } from "../Belief/GameData";

async function optionGeneration(){
    agentData.options = [];

    for (let p of agentData.parcels.values()) {
        if (!p.carriedBy && p.reward > 5 ) {
            let utility = compute_pickup_utility(p);
        }
    }
}

/**
 * 
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel} parcel 
 */
// TODO: Add edge case where parcel decay is disabled.
function compute_pickup_utility(parcel) {
    let numBaggedParcels = agentData.baggedParcels.size();
    let baggedReward = agentData.get_carried_score();
    let distanceToParcel = distance(agentData.pos, parcel.x, parcel.y );
    let distanceToNearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
    let totalDistance = (distanceToParcel + distanceToNearestDelivery);

    let decayFrequency = (gameData.movementDuration / gameData.parcelDecayingInterval)
    
    for (baggedParcel of agentData.baggedParcels) {
        let expectedParcelReward = baggedParcel.reward - decayFrequency * totalDistance;

        if (expectedParcelReward <= 0) {
            numBaggedParcels --;
            baggedReward -= baggedParcel.reward;       
        }
    }
    let ExpectedParcelReward = parcel.reward - decayFrequency * distanceToParcel;
    let BaggedReward = baggedReward - ((decayFrequency * distanceToParcel) * numBaggedParcels);
    
    let utility = (ExpectedParcelReward + baggedReward) - (decayFrequency * distanceToNearestDelivery) * (numBaggedParcels + 1);

    /** TODO: think about adding a malus to this utility in order to reduce the priority
     * that picking up a parcel would have over other actions.
     * It would prevent a case where the agent would keep picking up parcels but not actually deliver.
     */

    return utility;
}