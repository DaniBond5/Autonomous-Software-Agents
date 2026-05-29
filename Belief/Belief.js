import { AgentData } from "./AgentData.js";
import { socket } from "../connection.js";
import { GameData } from "./GameData.js";

const agentData = new AgentData();
const gameData = new GameData();

socket.onYou( ({id, name, x, y, score}) => {
    agentData.updateFromYou({id, name, x, y, score});
})

// TODO: currently, baggedParcels keeps decayed parcels, need to figure out where to put that logic
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
    }
})

socket.onSensing( async (sensing) => {
    for (const a of sensing.agents) {
        if (!a.x || !a.y) {
            continue;
        }
        if (a.x % 1 != 0 || a.y % 1 != 0) {
            continue;
        }
        if (!agentData.enemyAgents.has(a.id)) {
            agentData.enemyAgents.set(a.id, a);
        }else{
            let lastEnemyAgentPosition = { x: agentData.enemyAgents.get(a.id).x, y: agentData.enemyAgents.get(a.id).y};
            if (lastEnemyAgentPosition.x != a.x && lastEnemyAgentPosition.y != a.y) {
                agentData.enemyAgents.set(a.id, a);
            }
        }
    }
})

socket.onConfig( async (config) => {
    gameData.updateFromConfig(config);
})

socket.onMap( async (width, height, tileset) => {
    gameData.updateFromOnMap(width, height, tileset);
})

export{agentData, gameData}