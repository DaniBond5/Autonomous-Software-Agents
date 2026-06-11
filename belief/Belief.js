import { AgentData } from "./AgentData.js";
import { socket } from "../connection.js";
import { GameData } from "./GameData.js";
import { distance } from "../utils/geometry.js";

const agentData = new AgentData();
const gameData = new GameData();

/**
 * Function that handles the onYou sensing event.
 */
socket.onYou( ({id, name, x, y, score}) => {
    agentData.updateFromYou({id, name, x, y, score});
})


socket.onSensing( async (sensing) => {
    agentData.updateParcelsFromSensing(sensing.parcels, gameData.observationDistance);
    agentData.updateAgentsFromSensing(sensing.agents, gameData.observationDistance);
})

/**
 * This function handles the onConfig sensing event.
 */
socket.onConfig( async (config) => {
    gameData.updateFromConfig(config);
})

/**
 * This function handles the onMap sensing event.
 */
socket.onMap( async (width, height, tileset) => {
    gameData.updateFromOnMap(width, height, tileset);
})

export{agentData, gameData}