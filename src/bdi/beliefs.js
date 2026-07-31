import {
    distanceFromSearch,
    shortestPathsFrom
} from "../utils/geometry.js";

/**
 * This constant is used to convert position coordinates into a standard key to be used for all data structures that involve positions and need one.
 * @param {{x, y}} position 
 * @returns {string} a string representing a key to be used for data structures involving positions.
 */
export const POSITION_KEY = ({ x, y }) => `${x},${y}`;

/**
 * This constant acts as a function that checks and returns if a given position is finite.
 * @param {{x: number, y: number}} position 
 * @returns {boolean} true if the position is finite, false otherwise.
*/
const isFinitePosition = position =>
    Number.isFinite(position?.x)
    && Number.isFinite(position?.y);

/**
 * This function returns a number representing the parcel reward decay interval in milliseconds given a string stating the interval.
 * @param {string} event 
 * @returns {number} the parcel decay interval in milliseconds
*/
function parseLocalDecayIntervalMs(event) {
    switch (event) {
        case '1s': return 1000;
        case '2s': return 2000;
        case '5s': return 5000;
        case '10s': return 10000;
        case '1m': return 60000;
        case '1h': return 3600000;
        case 'infinite': return 0;
        default: return 1000;
    }
}

/**
 * This function updates every spawner and delivery point contained in their respective maps.
 * Specifically, it updates the boolean canReachOperationalx (x/spawner/delivery).
 * This function is particularly useful for maps where there are delivery tiles or spawner tiles that lead to deadlocks once reached.
 * @param {Beliefs} beliefs an agent's beliefs
*/
function updateOperationalReachability(beliefs) {
    const spawners = Array.from(beliefs.world.spawners.values());
    const deliveries = Array.from(beliefs.world.deliveries.values());
    const spawnerSearches = new Map();
    const deliverySearches = new Map();

    for (const spawner of spawners) {
        spawnerSearches.set(
            spawner,
            shortestPathsFrom(beliefs, spawner)
        );
    }
    for (const delivery of deliveries) {
        deliverySearches.set(
            delivery,
            shortestPathsFrom(beliefs, delivery)
        );
    }

    for (const delivery of deliveries) {
        delivery.canReachOperationalSpawner = spawners.some(spawner =>
            Number.isFinite(distanceFromSearch(
                deliverySearches.get(delivery),
                spawner
            ))
            && Number.isFinite(distanceFromSearch(
                spawnerSearches.get(spawner),
                delivery
            ))
        );
    }

    for (const spawner of spawners) {
        spawner.canReachOperationalDelivery = deliveries.some(delivery =>
            delivery.canReachOperationalSpawner === true
            && Number.isFinite(distanceFromSearch(
                spawnerSearches.get(spawner),
                delivery
            ))
        );
    }
}

/**
 * This class represents the agent's own data: identity, position and score.
 * It also allows to update them through different functions.
*/
class Me {
    constructor() {
        /**
         * @type {string}
         */
        this.id = "";

        /**
         * @type {string}
         */
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
     * This function updates the agent's data.
     * The first time this function is called, id and name are initialised.
     * The following calls update position and score.
     * Position is updated ONLY when both x and y are integers, gating fractional steps.
     * @param {{id: string, name: string, x: number, y: number}} agentData 
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
     * This function updates the agent's position and is to be used after a succesful move.
     * In particular, this function is used right after emitMove resolves succesfully.
     * Doing this allows the re-planning in the next cycle to start from the actual agent's position instead of relying on a stale onYou belief.
     * @param {{x: number, y: number}} position 
    */
    applyMovement({ x, y }) {
        this.pos.x = Math.round(x);
        this.pos.y = Math.round(y);
    }
}

/**
 * This class represents the agent's beliefs regarding parcels.
 * In particular, this class contains a Map for visible, known and carried parcels.
 * The class also provides functions to update these maps given the respective sensing.
*/
class Parcels {
    constructor() {
        /**
         * This map contains all the parcels seen during the latest sensing.
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel> }
        */
        this.visible = new Map();

        /**
         * This map contains all "known" parcels, along a @type {Date} variable stating when they've been observed.
         * A known parcel is a parcel that has been observed in the past during previous sensings.
         * This map holds these parcels until their last known position is observed and they're not present.
         * Before that happens, this map can contain outdated information by design.
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel & {observedAt: Date}> }
        */
        this.known = new Map();

        /**
         * This map contains the parcels currently carried by the agent.
         * @type { Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel> }
        */
        this.carried = new Map();
    }

    /**
     * This function updates parcel beliefs given the current sensing.
     * A known parcel is forgotten when its last known position is observed without it.
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} perceivedParcels
     * @param {string} meId
     * @param {function({x: number, y: number}): boolean} isVisible
    */
    update(perceivedParcels, meId, isVisible) {
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
                continue;
            }

            this.known.delete(parcel.id);
            if (parcel.carriedBy !== meId || parcel.reward <= 0) {
                this.carried.delete(parcel.id);
            } else {
                this.carried.set(parcel.id, parcel);
            }
        }

        for (const id of this.carried.keys()) {
            if (!seenNow.has(id)) {
                this.carried.delete(id);
            }
        }

        for (const [id, parcel] of this.known) {
            if (!seenNow.has(id) && isVisible(parcel)) {
                this.known.delete(id);
            }
        }
    }

    /**
     * This function reconciles parcel beliefs after a successful pickup or putdown outcome.
     * In particular it updates the agent's parcel beliefs given the succesful result of either action.
     * @param {{status: string, action: {action: string} | null, result: *}} outcome
     * @param {string} meId
     * @param {{x: number, y: number}} mePos
    */
    reconcileActionOutcome(outcome, meId, mePos) {
        const actionType = outcome?.action?.action;
        if (outcome?.status !== 'succeeded'
            || (actionType !== 'pickup' && actionType !== 'putdown')
            || !Array.isArray(outcome.result)) return;

        if (actionType === 'putdown') {
            for (const id of this.carried.keys()) {
                this.visible.delete(id);
                this.known.delete(id);
            }
            this.carried.clear();
            return;
        }

        for (const resultParcel of outcome.result) {
            if (!resultParcel || typeof resultParcel !== 'object' || typeof resultParcel.id !== 'string') continue;

            const id = resultParcel.id;
            const storedParcel = this.visible.get(id)
                ?? this.known.get(id)
                ?? this.carried.get(id);
            const parcel = storedParcel ? { ...storedParcel } : {};
            for (const [field, value] of Object.entries(resultParcel)) {
                if (value !== undefined) parcel[field] = value;
            }

            this.visible.delete(id);
            this.known.delete(id);

            const hasCurrentPosition = isFinitePosition(mePos)
                && mePos.x >= 0 && mePos.y >= 0;
            if (hasCurrentPosition) {
                parcel.x = mePos.x;
                parcel.y = mePos.y;
            }

            if (!meId || !Number.isFinite(parcel.reward)
                || !isFinitePosition(parcel)) continue;

            delete parcel.observedAt;
            this.carried.set(id, { ...parcel, carriedBy: meId });
        }
    }

    /**
     * This function returns known parcels with their reward estimated using the current time and the parcel decay interval.
     * Parcels whose estimated reward is not positive are forgotten.
     * @param {number} localDecayIntervalMs local decay interval in milliseconds
     * @returns {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} the available known parcels with their estimated reward.
    */
    availableKnown(localDecayIntervalMs) {
        const now = Date.now();
        const available = [];

        for (const [id, rememberedParcel] of this.known) {
            let estimatedReward = rememberedParcel.reward;
            if (localDecayIntervalMs > 0) {
                estimatedReward -= Math.floor((now - rememberedParcel.observedAt) / localDecayIntervalMs);
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
     * This function computes and returns the total score of the parcels currently carried by the agent.
     * @returns {number} total score of carried parcels by the agent.
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
 * This class represents the agent's beliefs regarding crates, if they're present on the current map.
 * It also contains functions that update the agent's beliefs over crates upon sensing events and actions.
*/
class Crates {
    constructor() {
        /**
         * This map contains the crates perceived by the agent.
         * The crates are stored using their id as the key, and they're forgotten when their position is observed without them.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk/types/IOCrate.js").IOCrate>} 
        */
        this.known = new Map();

        /**
         * This map contains the known crates by the agent, indexed by their position instead of their id.
         * It effectively acts as a view of `known`, which remains the source of belief.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk/types/IOCrate.js").IOCrate>}
        */
        this.byPosition = new Map();
    }

    /** 
     * This function rebuilds the byPosition map. 
     * Since crates are few, a full rebuild is simpler than maintaining both maps by hand and the cost is acceptable. 
    */
    reindexByPosition() {
        this.byPosition.clear();
        for (const crate of this.known.values()) {
            this.byPosition.set(POSITION_KEY(crate), crate);
        }
    }

    /**
     * This function updates the agent's beliefs of the crates given their sensing and if they're currently visible.
     * @param {import("@unitn-asa/deliveroo-js-sdk/types/IOSensing.js").IOCrate []} perceivedCrates 
     * @param {boolean} isVisible 
    */
    update(perceivedCrates, isVisible) {
        const seenNow = new Set();

        for (const crate of perceivedCrates) {
            if (
                !crate
                || typeof crate.id !== 'string'
                || !isFinitePosition(crate)
            ) {
                continue;
            }

            this.known.set(crate.id, {
                id: crate.id,
                x: crate.x,
                y: crate.y
            });
            seenNow.add(crate.id);
        }

        for (const [id, crate] of this.known) {
            if (!seenNow.has(id) && isVisible(crate)) {
                this.known.delete(id);
            }
        }

        this.reindexByPosition();
    }

    /**
     * This function checks and returns if a given position is occupied by a crate.
     * @param {{x: number, y: number}} position 
     * @returns {boolean} true if the given position is occupied by a crate, false otherwise.
    */
    isOccupied(position) {
        return this.getAt(position) !== null;
    }

    /** 
     * This function returns the crate occupying a given position, or null when that position doesn't contain one.
     * @returns {import("@unitn-asa/deliveroo-js-sdk/types/IOCrate.js").IOCrate | null} the crate occupying the position or null if not present.
    */
    getAt(position) {
        return this.byPosition.get(POSITION_KEY(position)) ?? null;
    }

    /**
     * This function reconciles a successful PDDL push with the remembered crate position.
     * @param {Promise<import("./execution.js").ActionOutcome>} outcome
     * @returns 
    */
    reconcileActionOutcome(outcome) {
        const action = outcome?.action;
        if (
            outcome?.status !== 'succeeded'
            || action?.action !== 'move'
            || action?.source !== 'pddl'
            || action?.kind !== 'push'
        ) {
            return;
        }

        const { crateId, crateFrom, crateTo } = action;
        if (
            typeof crateId !== 'string'
            || !isFinitePosition(crateFrom)
            || !isFinitePosition(crateTo)
        ) {
            return;
        }

        const crate = this.known.get(crateId);
        if (!crate
            || crate.x !== crateFrom.x
            || crate.y !== crateFrom.y) return;

        this.known.set(crateId, {
            id: crateId,
            x: crateTo.x,
            y: crateTo.y
        });
        this.reindexByPosition();
    }
}

/**
 * This class represents the agent's beliefs regarding the other agents perceived on the map.
 * It also contains functions to update these beliefs given the perceived agents through sensing and a utility function.
*/
class Agents {
    constructor() {
        /**
         * This map contains the agents perceived through the latest sensing.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOAgent>}
         */
        this.others = new Map();
    }

    /**
     * This function replaces the perceived agents with the ones contained in the latest sensing.
     * An agent caught mid-move keeps its fractional coordinate: this is done by design,
     * as when an agent is mid-move two tiles are locked instead of one.
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOAgent[]} perceivedAgents
     */
    update(perceivedAgents) {
        const seenNow = new Set();

        for (const a of perceivedAgents) {
            if (a.x == null || a.y == null) continue;
            seenNow.add(a.id);
            this.others.set(a.id, a);
        }

        for (const id of this.others.keys()) {
            if (!seenNow.has(id)) {
                this.others.delete(id);
            }
        }
    }

    /**
     * This function checks and returns whether another agent occupies the given position.
     * The server locks both the starting and the ending tile of a move.
     * This is done by the server through fractional agents coordinates, making both tiles count as taken. 
     * For an agent standing still floor and ceil are the same value and this is the equality check.
     * @param {{x: number, y: number}} position
     * @returns {boolean} true if a given position is occupied by another agent, false otherwise.
    */
    isOccupied(position) {
        for (const agent of this.others.values()) {
            if (position.x >= Math.floor(agent.x)
                && position.x <= Math.ceil(agent.x)
                && position.y >= Math.floor(agent.y)
                && position.y <= Math.ceil(agent.y)) return true;
        }
        return false;
    }
}

/**
 * This value is used as a default value and is used until the server sends its own movement duration.
 * It states how long the agent waits before giving up on a blocked tile.
*/
const DEFAULT_MOVEMENT_DURATION_MS = 1000;

/**
 * This constant states the amount of time in moves that a blocked tile gives.
*/
const BLOCKING_AGENT_WAIT_MOVES = 2;

/**
 * This class represents the agent's beliefs over the game's world.
 * It stores map data, game configuration and observation metadata given by the game server and used by the agent.
 * It contains functions that allow the agent to update its world beliefs through sensing events and utility functions.
*/
class World {
    constructor() {
        /** Number of X coordinates in the map, not the maximum X coordinate. */
        this.width = 0;

        /** Number of Y coordinates in the map, not the maximum Y coordinate. */
        this.height = 0;

        /**
         * This set contains the visible positions observed in the latest sensing event.
         * @type {Set<string>}
        */
        this.visiblePositions = new Set();

        /**
         * This map contains the whole topology of the current game map. The coordinates are used as keys.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
        */
        this.tiles = new Map();

        /**
         * This map stores known spawner tiles, the time each one was last seen and if from their position an "operational" delivery tile can be reached.
         * An operational delivery tile is one that, when reached, doesn't lead to a deadlock.
         * This value is useful for certain edge cases in particular maps where reaching a delivery point doesn't allow the agent to leave a dead end.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile & {lastCheckedAt: number, canReachOperationalDelivery: boolean}>}
        */
        this.spawners = new Map();

        /** 
         * This map contains known delivery tiles, the time each one was last seen and if from their position an "operational" parcel spawner tile can be reached.
         * An operational spawner tile is one that, when reached, doesn't lead to a deadlock.
         * Again, this value is useful for the same cases already explained for the spawners map.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile & {canReachOperationalSpawner: boolean}>} */
        this.deliveries = new Map();

        /**
         * @type {number}
        */
        this.movementDuration = -1;

        /**
         * @type {number}
         */
        this.observationDistance = -1;

        /** Local decay extrapolation interval in ms; 0 disables local extrapolation. */
        this.localDecayIntervalMs = 0;

        /**
         * Average parcel reward.
         * @type {number}
         */
        this.avgReward = -1;

        /**
         * Variance of the parcels' rewards
         * @type {number}
         */
        this.rewardVariance = -1;
    }

    /** 
     * This function updates the agent's beliefs of the game world given the respective sensing.
     * It effectively applies the server game configuration.
     * @param {import ("@unitn-asa/deliveroo-js-sdk/types/IOConfig.js").IOConfig} config
     */
    updateFromConfig(config) {
        if (!config || !config.GAME) return;

        const playerConfig = config.GAME.player
        this.movementDuration = playerConfig.movement_duration;
        this.observationDistance = playerConfig.observation_distance;

        const parcelsConfig = config.GAME.parcels
        this.localDecayIntervalMs = parseLocalDecayIntervalMs(parcelsConfig.decaying_event);
        this.avgReward = parcelsConfig.reward_avg;
        this.rewardVariance = parcelsConfig.reward_variance;
    }

    /**
     * This function rebuilds the local map state from the latest game map information received by the server.
     * The received tiles are the effective source for both topology and dimensions.
     * Width and height are coordinate counts, not maximum valid coordinates.
     * @param {number} _reportedWidth 
     * @param {number} _reportedHeight 
     * @param {import ("@unitn-asa/deliveroo-js-sdk").IOTile []} tileset 
     */
    updateFromMap(_reportedWidth, _reportedHeight, tileset) {
        this.tiles.clear();
        this.spawners.clear();
        this.deliveries.clear();

        const mapLoadedAt = Date.now();
        let maxX = -1;
        let maxY = -1;
        for (const tile of tileset) {
            const tileType = tile.type;
            const key = `${tile.x},${tile.y}`;
            this.tiles.set(key, tile);
            if (tileType == 1) {
                this.spawners.set(key, {
                    ...tile,
                    lastCheckedAt: mapLoadedAt,
                    canReachOperationalDelivery: false
                });
            }
            if (tileType == 2) {
                this.deliveries.set(key, {
                    ...tile,
                    canReachOperationalSpawner: false
                });
            }
            maxX = Math.max(maxX, tile.x);
            maxY = Math.max(maxY, tile.y);
        }

        this.width = maxX + 1;
        this.height = maxY + 1;
    }

    /**
     * This function rebuilds the visiblePositions set with the latest sensed positions.
     * @param {{x, y} []} positions 
     */
    updateVisiblePositions(positions) {
        this.visiblePositions.clear();

        for (const position of positions ?? []) {
            if (!isFinitePosition(position)) continue;
            this.visiblePositions.add(POSITION_KEY(position));
        }
    }

    /**
     * This function returns whether a given position was observed in the latest sensing event.
     * @returns {boolean} true if the given position was observed in the latest sensing, false otherwise.
     */
    isVisible(position) {
        if (!isFinitePosition(position)) return false;
        return this.visiblePositions.has(POSITION_KEY(position));
    }

    /**
     * This function returns whether a given position can contain a crate or if one can be moved there.
     * @param {{x, y}} position 
     * @returns true if the given position contains a crate or if one can be moved there, false otherwise.
     */
    isCrateSpace(position) {
        const tile = this.tiles.get(POSITION_KEY(position));
        if (!tile) return false;
        const tileType = String(tile.type);
        return tileType === '5' || tileType === '5!';
    }

    /**
     * This function updates the last check time of the spawners observed with the latest sensing.
     */
    markVisibleSpawners() {
        const checkedAt = Date.now();
        for (const spawner of this.spawners.values()) {
            if (this.isVisible(spawner)) {
                spawner.lastCheckedAt = checkedAt;
            }
        }
    }

    /**
     * This function returns the locally predicted reward loss during one movement.
     * A zero interval disables local extrapolation, meaning no decay is applied.
     * @returns {number} the locally predicted decay per movement, 0 if decay is disabled by the server.
     */
    decayPerMove() {
        if (this.localDecayIntervalMs <= 0) return 0;
        return this.movementDuration / this.localDecayIntervalMs;
    }

    /**
     * This function returns how long to wait for another agent to clear a tile, in milliseconds.
     * The value is computed in movements so the wait scales with the speed of the game.
     * @returns {number} the tile clear wait time in milliseconds, scaled with movements.
     */
    blockingAgentWaitMs() {
        const movementDuration = Number.isFinite(this.movementDuration)
            && this.movementDuration > 0
            ? this.movementDuration
            : DEFAULT_MOVEMENT_DURATION_MS;
        return movementDuration * BLOCKING_AGENT_WAIT_MOVES;
    }
}

/**
 * This class is an Aggregator that owns the belief components and wires them to the socket.
 * It only coordinates and delegates, it contains no domain logic.
 * One instance per agent, built by agent.js, so two agents in the same
 * process cannot overwrite each other's beliefs.
 */
export class Beliefs {
    constructor() {
        this.me = new Me();
        this.parcels = new Parcels();
        this.crates = new Crates();
        this.agents = new Agents();
        this.world = new World();
    }

    init(socket) {
        socket.onYou((payload) => {
            this.me.update(payload);
        });

        socket.onSensing((sensing) => {
            this.world.updateVisiblePositions(sensing.positions ?? []);
            const isVisible = position => this.world.isVisible(position);
            this.parcels.update(
                sensing.parcels ?? [],
                this.me.id,
                isVisible
            );
            this.crates.update(
                sensing.crates ?? [],
                isVisible
            );
            this.agents.update(sensing.agents ?? []);
            this.world.markVisibleSpawners();
        });

        socket.onConfig((config) => {
            this.world.updateFromConfig(config);
        });

        socket.onMap((reportedWidth, reportedHeight, tileset) => {
            this.world.updateFromMap(reportedWidth, reportedHeight, tileset);
            updateOperationalReachability(this);
        });
    }
}
