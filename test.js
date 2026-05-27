import { agentData } from "./Belief/belief.js"; 
import { gameData } from "./Belief/belief.js";

console.log(" Avvio del test");

setInterval(() => {
    
    console.log("\nINFORMAZIONI MAPPA");
    console.log("Width: ", gameData.mapWidth, " Height: ", gameData.mapHeight);

    console.log("\nSTATO AGENTE");
    
    console.log(`Nome: ${agentData.name || "Sconosciuto"} (ID: ${agentData.id || "N/A"})`);
    console.log(`Posizione attuale: x: ${agentData.pos.x}, y: ${agentData.pos.y}`);
    
    console.log(`Pacchi sulla mappa (visti): ${agentData.parcels.size}`);
    console.log(`Pacchi nello zaino: ${agentData.baggedParcels.size}`);
    
    console.log(`Valore totale nello zaino: ${agentData.get_carried_score()}`);
    
    console.log("--------------------\n");

}, 5000);