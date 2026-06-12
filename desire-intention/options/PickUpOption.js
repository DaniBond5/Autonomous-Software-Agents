import { distance } from "../../utils/geometry.js";
import { Option } from "./Option.js";
import { computeExpectedUtilityInfo } from "./optionsUtils.js";

export class PickUpOption extends Option {
    
    /**
     * A PickUpOption object is defined by its type, utility and the parcel it refers to.
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel} parcel 
     */
    constructor(parcel) {
        super('go_pick_up');
        this.parcel = parcel;
    }

    /**
     * This function computes and returns the utility for picking up this.parcel.
     * @param {import("../../belief/AgentData").AgentData} agentData 
     * @param {import("../../belief/GameData").GameData} gameData 
     * @returns {number} the utility for picking up this.parcel.
     */
    computeUtility(agentData, gameData) {
        let distanceToParcel = distance(agentData.pos, {x: this.parcel.x, y: this.parcel.y});
        let nearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
        let distanceToDelivery = distance(agentData.pos, {x: nearestDelivery.x, y: nearestDelivery.y});
        let decayFrequency = gameData.getDecayFrequency();
        
        let expectedInfo = computeExpectedUtilityInfo(agentData, gameData, (distanceToParcel + distanceToDelivery));
        let expectedNumBaggedParcels = expectedInfo[0];
        let expectedBaggedReward = expectedInfo[1] - ((decayFrequency * distanceToParcel) * expectedNumBaggedParcels);
        let expectedParcelReward = this.parcel.reward - decayFrequency * distanceToParcel;
        let utility = (expectedParcelReward + expectedBaggedReward) - ( (decayFrequency * distanceToDelivery) * (expectedNumBaggedParcels + 1) );

        // TODO: add a penalty to the utility if an aenemy agent is close to the parcel.

        /** TODO: think about adding a malus to this utility in order to reduce the priority that picking up a parcel would have over other actions.
         * It would prevent a case where the agent would keep picking up parcels but not actually deliver.
         */
        this.utility = utility;

        return utility;
    }
}