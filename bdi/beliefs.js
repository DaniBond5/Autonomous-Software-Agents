import { distance } from "../utils/geometry.js";

const NO_PARCEL_DECAY_VALUE = 0;

/**
 * Holds the agent's own data: identity, position and score.
 */
class Me {
    constructor() {
        this.id = "";
        this.name = "";

        /**
         * @type {{x: number, y: number}}
         */
        this.pos = { x: -1, y: -1 };

        /**
         * @type {number}
         */
        this.score = 0;
    }

    /**
     * Updates the agent's own data.
     * On the first call it initialises id and name, the following calls update
     * position and score.
     * Position is updated ONLY when both x and y are integers (gates fractional
     * movement steps).
     */
    update({ id, name, x, y, score }) {
        if (this.id == "" || this.name == "") {
            this.id = id;
            this.name = name;
        }
        if (x % 1 == 0 && y % 1 == 0) {
            this.pos.x = x;
            this.pos.y = y;
        }
        this.score = score;
    }
}

/**
 * Holds parcel data: parcels currently visible and parcels carried by the agent.
 */
class Parcels {
    constructor() {
        /**
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel> }
         */
        this.visible = new Map();

        /**
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel> }
         */
        this.carried = new Map();
    }

    update(perceivedParcels, meId) {

        const seenNow = new Set();

        for (const p of perceivedParcels) {
            this.visible.set(p.id, p);
            seenNow.add(p.id);
            if (p.carriedBy === meId) {
                if (p.reward <= 1) this.carried.delete(p.id);
                else this.carried.set(p.id, p);
            }
        }


        for (const id of this.visible.keys()) {
            if (!seenNow.has(id)) {
                this.visible.delete(id);
                this.carried.delete(id);
            }
        }
    }

    /**
     * @returns total score of carried parcels
     */
    carriedScore() {
        let score = 0;
        for (const parcel of this.carried.values()) {
            score += parcel.reward;
        }
        return score;
    }
}

/**
 * Holds the other agents perceived on the map.
 */
class Agents {
    constructor() {
        /**
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOAgent>}
         */
        this.others = new Map();
    }

    update(perceivedAgents) {

        const seenNow = new Set();

        for (const a of perceivedAgents) {
            if (a.x == null || a.y == null) continue;
            seenNow.add(a.id);
            if (a.x % 1 != 0 || a.y % 1 != 0) continue;
            this.others.set(a.id, a);
        }

        for (const id of this.others.keys()) {
            if (!seenNow.has(id)) {
                this.others.delete(id);
            }
        }
    }
}

/**
 * Holds static game/world data: map dimensions, tiles and game configuration.
 */
class World {
    constructor() {
        this.width = -1;
        this.height = -1;

        /** Can't use objects as key for maps, solution is to use a string defining the coordinates of the tile instead.
         * Positions are unique anyway.
         * This is the complete map of the current game.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
         */
        this.tiles = new Map();

        /**
         * This map stores the parcel spawning tiles
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
         */
        this.spawners = new Map();

        /**
         * This map stores the parcel delivery tiles
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
         */
        this.deliveries = new Map();

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
        this.decayInterval = -1;

        /**
         * @type {number}
         */
        this.avgReward = -1;

        /**
         * @type {number}
         */
        this.rewardVariance = -1;
    }

    /**
     * Function that initialises all game data values given a IOConfig
     *
     * @param {import ("@unitn-asa/deliveroo-js-sdk/types/IOConfig.js").IOConfig} config
     */
    updateFromConfig(config) {
        if (!config || !config.GAME) return;

        const playerConfig = config.GAME.player
        this.movementDuration = playerConfig.movement_duration;
        this.observationDistance = playerConfig.observation_distance;

        const parcelsConfig = config.GAME.parcels
        // TODO: there's also a 'frame' decaying interval, need to figure out its measure and add an initialization for that case
        let decay = parcelsConfig.decaying_event;
        if (decay.includes('s')) {
            this.decayInterval = Number(decay.substring(0, decay.indexOf('s')));
        }
        else if (decay === 'infinite') this.decayInterval = NO_PARCEL_DECAY_VALUE;
        this.avgReward = parcelsConfig.reward_avg;
        this.rewardVariance = parcelsConfig.reward_variance;
    }

    /**
     * Function that saves the map information received upon a onMap sensing.
     * Saves map width, map height and the tileset.
     * Currently RESETS the tiles
     */
    updateFromMap(width, height, tileset) {
        this.width = width;
        this.height = height;

        this.tiles.clear();
        this.spawners.clear();
        this.deliveries.clear();
        for (const tile of tileset) {
            const tileType = tile.type;
            const key = `${tile.x},${tile.y}`;
            this.tiles.set(key, tile);
            if (tileType == 1) this.spawners.set(key, tile);
            if (tileType == 2) this.deliveries.set(key, tile);
        }
    }

    /** TODO: naive implementation, will probably have to go for something else once we implement
     * search algorithms or PDDL
     * Function that returns the closest delivery tile given a coordinate
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOTile} pos
     * @returns the nearest delivery tile wrt the given coordinates
     */
    nearestDelivery({ x, y }) {
        const nearestDelivery = Array.from(this.deliveries.values())
            .sort((a, b) => distance({ x, y }, a) - distance({ x, y }, b))
            .shift();
        return nearestDelivery;
    }

    /**
     * TODO: Another naive implementation for a first attempt at making it all work
     * Function that returns the closest parcel spawning tile given a coordinate.
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOTile} pos
     * @returns the nearest parcel spawning tile wrt the given coordinates
     */
    nearestSpawner({ x, y }) {
        const nearestSpawningTile = Array.from(this.spawners.values())
            .sort((a, b) => distance({ x, y }, a) - distance({ x, y }, b))
            .shift();
        return nearestSpawningTile;
    }

    /**
     * This function returns the frequency of parcel decay.
     * If the decaying interval is set to 0, it returns 0, otherwise it computes the frequency
     * @returns the parcel decay frequency
     */
    decayFrequency() {
        if (this.decayInterval == NO_PARCEL_DECAY_VALUE) return 0;
        return (this.movementDuration / this.decayInterval) / 1000;
    }
}

/**
 * Aggregator that owns the belief components and wires them to the socket.
 * It only coordinates and delegates, it contains no domain logic.
 */
class Beliefs {
    constructor() {
        this.me = new Me();
        this.parcels = new Parcels();
        this.agents = new Agents();
        this.world = new World();
    }

    /**
     * Wires the belief components to the socket sensing events.
     */
    init(socket) {
        socket.onYou(({ id, name, x, y, score }) => {
            this.me.update({ id, name, x, y, score });
        });

        socket.onSensing(async (sensing) => {
            this.parcels.update(sensing.parcels, this.me.id);
            this.agents.update(sensing.agents);
        });

        socket.onConfig(async (config) => {
            this.world.updateFromConfig(config);
        });

        socket.onMap(async (width, height, tileset) => {
            this.world.updateFromMap(width, height, tileset);
        });
    }
}

export const beliefs = new Beliefs();
