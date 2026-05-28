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
            this.pos.x = Math.round(x);
            this.pos.y = Math.round(y);
    }

    /**
     * @returns total score of bagged parcels
     */
    get_carried_score = () => {
        let total = 0;
        for (const parcel of this.baggedParcels.values()) {
            total += parcel.reward;
        }
        return total;
    }
    
}


export {AgentData}