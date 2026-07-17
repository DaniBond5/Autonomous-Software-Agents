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

    /**
     * Applies the authoritative position confirmed by a successful move.
     * Used right after emitMove resolves, so re-planning the next cycle starts
     * from the real tile instead of a stale onYou belief (prevents overshoot).
     */
    applyMovement({ x, y }) {
        this.pos.x = Math.round(x);
        this.pos.y = Math.round(y);
    }
}

/**
 * Holds parcel data: parcels currently visible, remembered and carried by the agent.
 */
class Parcels {
    constructor() {
        /**
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel> }
         */
        this.visible = new Map();

        /**
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel & {observedAt: number}> }
         */
        this.known = new Map();

        /**
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel> }
         */
        this.carried = new Map();
    }

    update(perceivedParcels, meId, mePos, observationDistance) {
        this.visible.clear();
        const seenNow = new Set();
        const observedAt = Date.now();

        for (const p of perceivedParcels) {
            const parcel = { ...p };
            this.visible.set(parcel.id, parcel);
            seenNow.add(parcel.id);

            if (!parcel.carriedBy && parcel.reward > 0) {
                this.known.set(parcel.id, { ...parcel, observedAt });
                this.carried.delete(parcel.id);
            }
            else if (parcel.carriedBy === meId) {
                this.known.delete(parcel.id);
                if (parcel.reward <= 1) this.carried.delete(parcel.id);
                else this.carried.set(parcel.id, parcel);
            }
            else {
                this.known.delete(parcel.id);
                this.carried.delete(parcel.id);
            }
        }

        for (const id of this.carried.keys()) {
            if (!seenNow.has(id)) {
                this.carried.delete(id);
            }
        }

        const canInvalidateByPosition = mePos.x >= 0 && mePos.y >= 0 && observationDistance >= 0;
        if (canInvalidateByPosition) {
            for (const [id, parcel] of this.known) {
                if (!seenNow.has(id) && distance(mePos, parcel) <= observationDistance) {
                    this.known.delete(id);
                }
            }
        }
    }

    /**
     * Reconciles parcel beliefs with a successful pickup or putdown outcome.
     * @param {{status: string, action: {action: string} | null, result: *}} outcome
     * @param {string} meId
     * @param {{x: number, y: number}} mePos
     */
    reconcileActionOutcome(outcome, meId, mePos) {
        const actionType = outcome?.action?.action;
        if (outcome?.status !== 'succeeded'
            || (actionType !== 'pickup' && actionType !== 'putdown')
            || !Array.isArray(outcome.result)) return;

        for (const resultParcel of outcome.result) {
            if (!resultParcel || typeof resultParcel !== 'object' || typeof resultParcel.id !== 'string') continue;

            const id = resultParcel.id;
            if (actionType === 'putdown') {
                this.visible.delete(id);
                this.known.delete(id);
                this.carried.delete(id);
                continue;
            }

            const storedParcel = this.visible.get(id)
                ?? this.known.get(id)
                ?? this.carried.get(id);
            const parcel = storedParcel ? { ...storedParcel } : {};
            for (const [field, value] of Object.entries(resultParcel)) {
                if (value !== undefined) parcel[field] = value;
            }

            this.visible.delete(id);
            this.known.delete(id);

            const hasCurrentPosition = Number.isFinite(mePos?.x) && Number.isFinite(mePos?.y)
                && mePos.x >= 0 && mePos.y >= 0;
            if (hasCurrentPosition) {
                parcel.x = mePos.x;
                parcel.y = mePos.y;
            }

            if (!meId || !Number.isFinite(parcel.reward)
                || !Number.isFinite(parcel.x) || !Number.isFinite(parcel.y)) continue;

            delete parcel.observedAt;
            this.carried.set(id, { ...parcel, carriedBy: meId });
        }
    }

    /**
     * Returns remembered free parcels with their reward estimated at the current time.
     * Parcels whose estimated reward is no longer positive are forgotten.
     * @param {number} decayInterval parcel decay interval in seconds
     * @returns {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]}
     */
    availableKnown(decayInterval) {
        const now = Date.now();
        const available = [];

        for (const [id, rememberedParcel] of this.known) {
            let estimatedReward = rememberedParcel.reward;
            if (decayInterval > 0) {
                estimatedReward -= Math.floor((now - rememberedParcel.observedAt) / (decayInterval * 1000));
            }

            if (estimatedReward <= 0) {
                this.known.delete(id);
                continue;
            }

            const { observedAt, ...parcel } = rememberedParcel;
            available.push({ ...parcel, reward: estimatedReward });
        }

        return available;
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

    /**
     * Returns whether another agent occupies the given tile.
     * @param {{x: number, y: number}} position
     * @returns {boolean}
     */
    isOccupied(position) {
        for (const agent of this.others.values()) {
            if (agent.x === position.x && agent.y === position.y) return true;
        }
        return false;
    }
}

/**
 * Holds static game/world data: map dimensions, tiles and game configuration.
 */
class World {
    constructor() {
        /** Number of X coordinates in the map, not the maximum X coordinate. */
        this.width = 0;

        /** Number of Y coordinates in the map, not the maximum Y coordinate. */
        this.height = 0;

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
     * The received tiles are the authoritative source for both topology and dimensions.
     * Width and height are coordinate counts, not maximum valid coordinates.
     * Currently RESETS the tiles
     */
    updateFromMap(_reportedWidth, _reportedHeight, tileset) {
        this.tiles.clear();
        this.spawners.clear();
        this.deliveries.clear();

        let maxX = -1;
        let maxY = -1;
        for (const tile of tileset) {
            const tileType = tile.type;
            const key = `${tile.x},${tile.y}`;
            this.tiles.set(key, tile);
            if (tileType == 1) this.spawners.set(key, tile);
            if (tileType == 2) this.deliveries.set(key, tile);
            maxX = Math.max(maxX, tile.x);
            maxY = Math.max(maxY, tile.y);
        }

        this.width = maxX + 1;
        this.height = maxY + 1;
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
            this.parcels.update(
                sensing.parcels,
                this.me.id,
                this.me.pos,
                this.world.observationDistance
            );
            this.agents.update(sensing.agents);
        });

        socket.onConfig(async (config) => {
            this.world.updateFromConfig(config);
        });

        socket.onMap(async (reportedWidth, reportedHeight, tileset) => {
            this.world.updateFromMap(reportedWidth, reportedHeight, tileset);
        });
    }
}

export const beliefs = new Beliefs();
