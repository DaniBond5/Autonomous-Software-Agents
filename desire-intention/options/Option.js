export class Option {
    constructor(type) {
        this.type = type;
        this.utility = 0;
    }

    /**
     * This abstract method is responsible for computing the utility for a given option.
     * Every option class has to implement it, calling this method with an Option Object will throw an expection.
     * @param {import("../../belief/AgentData")} agentData 
     * @param {import("../../belief/GameData")} gameData 
     */
    computeUtility(agentData, gameData) {
        throw new Error("The 'computeUtility()' method must be implemented.");
    }
}