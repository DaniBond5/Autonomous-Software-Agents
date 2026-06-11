import { AgentData } from "./AgentData.js";
import { socket } from "../connection.js";
import { distance, GameData } from "./GameData.js";

const agentData = new AgentData();
const gameData = new GameData();

/**
 * Function that handles the onYou sensing event.
 */
socket.onYou( ({id, name, x, y, score}) => {
    agentData.updateFromYou({id, name, x, y, score});
})

// TODO: currently, baggedParcels keeps decayed parcels, need to figure out where to put that logic
/**
 * Sensing function that handles parcel sensing.
 * This function populates the agent's parcels map and removes parcels whose reward is <= 1
 * TODO: might not be enough to remove all decayes parcels, tests needed
 */
socket.onSensing( async (sensing) => {
    for (const p of sensing.parcels) {
        agentData.parcels.set(p.id, p);
        if(p.carriedBy === agentData.id) {
            if (p.reward <= 1) {
                agentData.baggedParcels.delete(p.id);
                continue;
            }
            agentData.baggedParcels.set(p.id, p);
        }
        for (let seenParcel of agentData.parcels.values()) {
            if(distance(agentData.pos, {x: seenParcel.x, y: seenParcel.y}) > gameData.observationDistance && !sensing.parcels.find( ({id: parcel_id}) => seenParcel.id == parcel_id )) {
                agentData.parcels.delete(seenParcel.id);
            }
        }
    }
})


/**
 * Sensing function that handles the sensing of other agents.
 * This function populates the agent's enemyAgents map with valid values, it skips agents that are in the process of moving (or trying to).
 * As of now, the agent only keeps track of the agents it can see at every agent sensing, so every agent that is no longer in the observation distance is removed.
 */
socket.onSensing( async (sensing) => {
    for (const a of sensing.agents) {
        if (a.x == null || a.y == null) continue;
        if (a.x % 1 != 0 || a.y % 1 != 0) continue;

        agentData.enemyAgents.set(a.id, a);
        
        for (let seenAgent of agentData.enemyAgents.values()) {
            // Previously seen agent is no longer in observation distance
            if (distance(agentData.pos, {x: seenAgent.x, y: seenAgent.y}) > gameData.observationDistance && !sensing.agents.find( ({id: agent_id}) => seenAgent.id == agent_id ) ) {
                    agentData.enemyAgents.delete(seenAgent.id);
            }
        }
    }
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