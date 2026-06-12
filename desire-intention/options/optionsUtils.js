/**
 * This function computes the expected values for the number of carried parcels and of the carried reward.
 * For each parcel in the agent's bag we compute its expected reward using a given distance.
 * If it's lte than 0, we count one less bagged parcel and remove its reward, in order to be able to compute a more precise utility value.
 * @param {import("../../belief/AgentData")} agentData
 * @param {import("../../belief/GameData")} gameData
 * @param {number} distance
 * @returns 
 */
export function computeExpectedUtilityInfo(agentData, gameData, distance) {
    let expectedNumBaggedParcels = agentData.baggedParcels.size;
    let expectedBaggedReward = agentData.getCarriedScore();
    let decayFrequency = gameData.getDecayFrequency();
    for (let baggedParcel of agentData.baggedParcels.values()) {
        let expectedParcelReward = baggedParcel.reward - (decayFrequency * distance);
        if (expectedParcelReward <= 0) {
            expectedNumBaggedParcels --;
            expectedBaggedReward -= baggedParcel.reward;
        }
    }
    return [expectedNumBaggedParcels, expectedBaggedReward];
}