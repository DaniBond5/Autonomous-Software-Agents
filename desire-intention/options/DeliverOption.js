import { distance } from "../../utils/geometry.js";
import { Option } from "./Option.js";
import { computeExpectedUtilityInfo } from "./optionsUtils.js";

export class DeliverOption extends Option {

    /**
     * A delivery option is defined by its type, utility and by the delivery tile that's closest.
     */
    constructor() {
        super('go_deliver');
        /** @type {import("@unitn-asa/deliveroo-js-sdk").IOTile | null} */
        this.deliveryPoint = null;
    }

    /**
     * This function computes and returns the utility for delivering given both the agent's data and the game's data.
     * @param {import("../../belief/AgentData").AgentData} agentData 
     * @param {import("../../belief/GameData").GameData} gameData
     * @returns {number} The computed utility for delivering.
     */
    computeUtility(agentData, gameData) {
        let nearestDelivery = gameData.getNearestDeliveryPoint(agentData.pos);
        let distanceToDelivery = distance(agentData.pos, {x: nearestDelivery.x, y: nearestDelivery.y});
        
        let expectedInfo = computeExpectedUtilityInfo(agentData, gameData, distanceToDelivery);
        let expectedNumBaggedParcels = expectedInfo[0];
        let expectedBaggedReward = expectedInfo[1];

        let decayFrequency = gameData.getDecayFrequency();
        let utility = expectedBaggedReward - ((decayFrequency * distanceToDelivery) * expectedNumBaggedParcels);
        // TODO: adding a bonus multiplier to this utility might be a good idea to make delivery more appetising.
        this.utility = utility;
        this.deliveryPoint = nearestDelivery;

        return utility;
    }
}