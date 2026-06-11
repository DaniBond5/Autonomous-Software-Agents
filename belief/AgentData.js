import { distance } from "../utils/geometry.js";

class AgentData{

    constructor(){
        this.id = "";
        this.name = "";
        
        /**
         * @type {{x: number, y: number}}
         */
        this.pos = {x: -1, y: -1};
        
        /**
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel> }
         */
        this.parcels = new Map();
        
        /**
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel }
         */
        this.baggedParcels = new Map();

        /**
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOAgent}
         */
        this.enemyAgents = new Map();

        this.options = [];
    }

    /**
     * Function that updates the basic data of the agent:
     * - id
     * - name
     * - position divided into coordinate x and y
     * - score
     * on the first call, it initialises both name and id, the following calls will update the position.
     */
    updateFromYou({id, name, x, y, score}) {
        if (this.id == "" || this.name == ""){
                this.id = id;
                this.name = name;
            }
            if (x % 1 == 0 && y % 1 == 0) {
                this.pos.x = x;
                this.pos.y = y;
            }
    }

    /**
     * @returns total score of bagged parcels
     */
    getCarriedScore() {
        let score = 0;
        for (const parcel of this.baggedParcels.values()) {
            score += parcel.reward;
        }
        return score;
    }


    updateFromSensing(perceivedParcels, observationDistance) {
        
        const seenNow = new Set();

        for (const p of perceivedParcels) {
            this.parcels.set(p.id, p);
            seenNow.add(p.id);
            if (p.carriedBy === this.id) {
                if (p.reward <= 1) this.baggedParcels.delete(p.id);
                else this.baggedParcels.set(p.id, p);
            }
        }


        for (const [id, parcel] of this.parcels) {
            if (!seenNow.has(id) && distance(this.pos, parcel) < observationDistance) {
                this.parcels.delete(id);
                this.baggedParcels.delete(id);
            }
        }   
    }


    updateAgentsFromSensing(perceivedAgents, observationDistance) {
    
        const seenNow = new Set();

        for (const a of perceivedAgents) {
            if (a.x == null || a.y == null) continue;
            seenNow.add(a.id);
            if (a.x % 1 != 0 || a.y % 1 != 0) continue;
            this.enemyAgents.set(a.id, a);
        }

        for (const [id, agent] of this.enemyAgents) {
            if (!seenNow.has(id) && distance(this.pos, agent) < observationDistance) {
                this.enemyAgents.delete(id);
            }
        }
    }
}


export {AgentData}