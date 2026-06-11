import { distance } from "../utils/geometry.js";

const NO_PARCEL_DECAY_VALUE = 0;

class GameData {

    /**
     * * @typedef {Object} Tile
     * @property {number} x
     * @property {number} y
     * @property {import("@unitn-asa/deliveroo-js-sdk/types/IOTile.js").IOTileType}
     */
    constructor(){
        this.mapWidth = -1;
        this.mapHeight = -1;

        /** Can't use objects as key for maps, solution is to use a string defining the coordinates of the tile instead.
         * Positions are unique anyway.
         * This is the complete map of the current game.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
         */
        this.gameMap = new Map();

        /**
         * This map stores the parcel spawning tiles
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
         */
        this.parcelSpawningMap = new Map();

        /**
         * This map stores the parcel delivery tiles
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
         */
        this.deliveryMap = new Map();

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
        this.movementDuration = playerConfig.movement_duration;
        this.observationDistance = playerConfig.observation_distance;

        const parcelsConfig = config.GAME.parcels
        // TODO: there's also a 'frame' decaying interval, need to figure out its measure and add an initialization for that case
        let decay = parcelsConfig.decaying_event;
        if (decay.includes('s')) {
            this.parcelDecayingInterval = Number(decay.substring(0, decay.indexOf('s')));
        }
        else if (decay === 'infinite') this.parcelDecayingInterval = NO_PARCEL_DECAY_VALUE;
        this.parcelAverageReward = parcelsConfig.reward_avg;
        this.parcelRewardVariance = parcelsConfig.reward_variance;
    }

    /**
     * Function that saves the map information received upon a onMap sensing.
     * Saves map width, map height and the tileset.
     * Currently RESETS the gameMap
     */
    updateFromOnMap(width, height, tileset) {
        this.mapWidth = width;
        this.mapHeight = height;

        this.gameMap.clear();
        this.parcelSpawningMap.clear();
        this.deliveryMap.clear();
        for (const tile of tileset){
            const tileType = tile.type;
            const key = `${tile.x},${tile.y}`;
            this.gameMap.set(key, tile);
            if (tileType == 1) this.parcelSpawningMap.set(key, tile);
            if (tileType == 2) this.deliveryMap.set(key, tile);
        }
    }
    
    /** TODO: naive implementation, will probably have to go for something else once we implement
     * search algorithms or PDDL
     * Function that returns the closest delivery tile given a coordinate
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOTile} tileCoordinates 
     * @returns the nearest delivery tile wrt the given coordinates
     */
    getNearestDeliveryPoint({x, y}) {
        const nearestDelivery = Array.from( this.deliveryMap.values() )
        .sort( (a, b) => distance({x,y} , a ) - distance( {x,y}, b ) )
        .shift();
        return nearestDelivery;
    }
 
    /**
     * This function returns the frequency of parcel decay.
     * If the decaying interval is set to 0, it returns 0, otherwise it computes the frequency
     * @returns the parcel decay frequency
     */
    getDecayFrequency(){
        if (this.parcelDecayingInterval == NO_PARCEL_DECAY_VALUE) return 0;
        return (this.movementDuration / this.parcelDecayingInterval) / 1000;
    }

    /**
     * TODO: Another naive implementation for a first attempt at making it all work
     * Function that returns the closest delivery tile given a coordinate.
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOTile} tileCoordinates 
     * @returns the nearest parcel spawning tile wrt the given coordinates
     */
    getNearestSpawningPoint({x, y}) {
        const nearestSpawningTile = Array.from( this.parcelSpawningMap.values() )
        .sort( (a, b) => distance({x,y} , a ) - distance( {x,y}, b ) )
        .shift();
        return nearestSpawningTile;
    }
}

export{GameData, NO_PARCEL_DECAY_VALUE}