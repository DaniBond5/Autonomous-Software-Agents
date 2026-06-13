import { socket } from "./connection.js";
import { beliefs } from "./bdi/beliefs.js";
import { generateDesires } from "./bdi/desires.js";

beliefs.init(socket);

console.log(" Avvio del test");

setInterval(() => {

    console.log("\nINFORMAZIONI MAPPA");
    console.log("Width: ", beliefs.world.width, " Height: ", beliefs.world.height);
    //console.log(beliefs.world.tiles);
    console.log(beliefs.world.spawners.size);
    console.log("parcel decaying interval: ", beliefs.world.decayInterval);

    console.log("\nSTATO AGENTE");

    console.log(`Nome: ${beliefs.me.name || "Sconosciuto"} (ID: ${beliefs.me.id || "N/A"})`);
    console.log(`Posizione attuale: x: ${beliefs.me.pos.x}, y: ${beliefs.me.pos.y}`);

    console.log(`Pacchi sulla mappa (visti): ${beliefs.parcels.visible.size}`);
    console.log('Dati sui pacchi visti: ', beliefs.parcels.visible);
    console.log(`Pacchi nello zaino: ${beliefs.parcels.carried.size}`);

    console.log(`Valore totale nello zaino: ${beliefs.parcels.carriedScore()}`);

    console.log("--------------------\n");

    console.log("\nDESIDERI:");
    console.log(generateDesires(beliefs));

}, 5000);
