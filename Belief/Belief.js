import { AgentData } from "./AgentData.js";
import {socket } from "../connection.js";

const agentData = new AgentData();

socket.onYou( ({id, name, x, y, score}) => {
    if (agentData.id == "" || agentData.name == ""){
        agentData.id = id;
        agentData.name = name;
    }
    agentData.pos.x = Math.round(x);
    agentData.pos.y = Math.round(y);
})

socket.onSensing( async (sensing) => {
    for (const p of sensing.parcels) {
        if (!p.carriedBy) {
            if (!agentData.parcels.has(p.id)) {
                agentData.parcels.set(p.id, p);
                console.log("stored a new parcel: ", p.id);
            }
        }else if(p.carriedBy == agentData.id) {
            if(!agentData.baggedParcels.has(p.id)) {
                agentData.baggedParcels.set(p.id, p);
                console.log("picked up parcel :", p.id);
            }
        }
    }
})

export{agentData}