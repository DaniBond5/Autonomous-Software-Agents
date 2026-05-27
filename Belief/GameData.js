class GameData {

    constructor(){
        this.mapWidth = -1;
        this.mapHeight = -1;

        /** Can't use objects as key for maps, solution is to use a string defining the coordinates of the tile instead.
         * Positions are unique anyway.
         * @type {Map  <string, string >}
         */
        this.gameMap = new Map();

        /**
         * @type {number}
         */
        this.movementDuration = -1;
        
        /**
         * @type {number}
         */
        this.observationDistance = -1;

        /**
         * @type {number}
         */
        this.parcelDecayingInterval = -1;

        /**
         * @type {number}
         */
        this.parcelAverageReward = -1;

        /**
         * @type {number}
         */
        this.parcelRewardVariance = -1;
    }

    /**
     * Function that initialises all game data values given a IOConfig
     * 
     * @param {import ("@unitn-asa/deliveroo-js-sdk/types/IOConfig.js").IOConfig} config
     */
    updateFromConfig(config)  {
        if (!config || !config.GAME) return;
        
        const playerConfig = config.GAME.player
        this.movementDuration = playerConfig.movementDuration;
        this.observationDistance = playerConfig.observation_distance;

        const parcelsConfig = config.GAME.parcels
        this.parcelDecayingInterval = parcelsConfig.decaying_event == '1s' ? 1000 : 1000000;
        this.parcelAverageReward = parcelsConfig.reward_avg;
        this.parcelRewardVariance = parcelsConfig.reward_variance;
    }

    /**
     * Function that saves the map information received upon a onMap sensing.
     * Saves map width, map height and the tileset.
     * Currently RESETS the gameMap!
     */
    updateFromOnMap(width, height, tileset) {
        this.mapWidth = width;
        this.mapHeight = height;

        this.gameMap = new Map();
        
        for (let i = 0; i < tileset.length; i++) {
            for (let j = 0; j < tileset[i].length; j++) {
                this.gameMap.set("${i},${y}", tileset[i][j]);
            }
        }
    }

    
}
export{GameData}