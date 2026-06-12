import { socket } from "../connection.js";
import { agentData, gameData } from "../belief/Belief.js";
import { distance } from "../utils/geometry.js";
import { PickUpOption } from "./options/PickUpOption.js";
import { DeliverOption } from "./options/DeliverOption.js";

const GO_DELIVER_THRESHOLD = 5;     // threshold to make the agent go deliver parcels if he has X * averageParcelReward parcels in its bag
const PARCEL_REWARD_THRESHOLD = 5;

async function optionGeneration(){
    agentData.options = []; // TODO: think about this

    /**
     * TODO: Might be useful to implement a class representing the option stack/array, may not be needed tho.
     * Chain of responsibility would be perfect for classes that need to operate differently depending on the option type.
     */

    for (let parcel of agentData.parcels.values()) {
        if (!parcel.carriedBy && parcel.reward > PARCEL_REWARD_THRESHOLD){
            let pickUpOption = new PickUpOption(parcel);
            if (pickUpOption.computeUtility(agentData, gameData) > 0 ) agentData.options.push(pickUpOption);
            console.log("pick up option for parcel: ", parcel,": ", pickUpOption);
        }
    }

    if ((agentData.baggedParcels.size > 0) && ( (gameData.getDecayFrequency() > 0) || (agentData.getCarriedScore() > gameData.parcelAverageReward * GO_DELIVER_THRESHOLD) )) {
        let deliveryOption = new DeliverOption();
        if (deliveryOption.computeUtility(agentData, gameData) > 0 ) agentData.options.push(deliveryOption);
        console.log("delivery option: ",deliveryOption);
    }

    if (agentData.parcels.size === 0 && agentData.baggedParcels.size === 0) {
        let explorationInfo = computeNearestSpawnerExplorationUtility();
        if (explorationInfo[0] !== null) {
            agentData.options.push(['go_to_spawner', explorationInfo[0].x, explorationInfo[0].y, explorationInfo[1]]);
        }
    }
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

export {optionGeneration, computeNearestSpawnerExplorationUtility} // Once everything is tested, it's likely that only optionGeneration will need to be exported