class AgentData{
    
    id = "";
    name = "";
    pos = {x: -1, y : -1};
    parcels = new Map();
    baggedParcels = new Map();

    constructor(){
        this.id = "";
        this.name = "";
        /**
         * @type {{x: number, y: number}}
         */
        this.pos = {x: -1, y: -1};
        /**
         * @type { Map string,  < id:string, carriedBy?: string, x: number, y: number, reward: number > }
         */
        this.parcels = new Map();
        /**
         * @type { Map string, < id:string, x: number, y: number, reward: number > }
         */
        this.baggedParcels = new Map();
    }

    get_carried_score = () => {
        let total = 0;
        for (bgdParcelKey of this.baggedParcels.keys()) {
            if (this.parcels.has(bgdParcelKey)) {
                baggedParcel = this.baggedParcels.get(bgdParcelKey)
                total += baggedParcel.reward
            }
        }
        return total;
    }
}

export {AgentData}