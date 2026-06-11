import { agentData, gameData } from "./belief/Belief.js";
import { computeNearestSpawnerExplorationUtility } from "./desire-intention/options.js";

console.log(" Avvio del test");

setInterval(() => {
    
    console.log("\nINFORMAZIONI MAPPA");
    console.log("Width: ", gameData.mapWidth, " Height: ", gameData.mapHeight);
    //console.log(gameData.gameMap);
    console.log(gameData.parcelSpawningMap.size);

    console.log("\nSTATO AGENTE");
    
    console.log(`Nome: ${agentData.name || "Sconosciuto"} (ID: ${agentData.id || "N/A"})`);
    console.log(`Posizione attuale: x: ${agentData.pos.x}, y: ${agentData.pos.y}`);
    
    console.log(`Pacchi sulla mappa (visti): ${agentData.parcels.size}`);
    console.log('Dati sui pacchi visti: ', agentData.parcels);
    console.log(`Pacchi nello zaino: ${agentData.baggedParcels.size}`);
    
    console.log(`Valore totale nello zaino: ${agentData.get_carried_score()}`);

    console.log("--------------------\n");

    console.log("\nOption generation:");

    console.log("nearest spawner utility: ", computeNearestSpawnerExplorationUtility());

}, 5000);