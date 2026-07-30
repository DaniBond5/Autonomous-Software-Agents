import {
    distanceFromSearch,
    shortestPathsFrom
} from "../utils/geometry.js";

const positionKey = ({ x, y }) => `${x},${y}`;
const isFinitePosition = position =>
    Number.isFinite(position?.x)
    && Number.isFinite(position?.y);

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

    /**
     * Updates parcel beliefs from the current sensing.
     * A remembered parcel is forgotten when its last known position is observed without it.
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
     * Returns remembered free parcels with their reward estimated at the current time.
     * Parcels whose estimated reward is no longer positive are forgotten.
     * @param {number} localDecayIntervalMs local decay extrapolation interval in milliseconds
     * @returns {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]}
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
 * Holds remembered crate positions.
 */
class Crates {
    constructor() {
        /** @type {Map<string, {id: string, x: number, y: number}>} */
        this.known = new Map();

        /**
         * Position view of `known`, which stays the source of truth.
         * getAt runs inside the neighbour expansion of the corridor search,
         * once per visited tile, where scanning every crate would be costly.
         * @type {Map<string, {id: string, x: number, y: number}>}
         */
        this.byPosition = new Map();
    }

    /** Rebuilds the position view. Crates are few, so a full rebuild is
     * simpler than keeping the two views in step by hand. */
    reindexByPosition() {
        this.byPosition.clear();
        for (const crate of this.known.values()) {
            this.byPosition.set(positionKey(crate), crate);
        }
    }

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

    isOccupied(position) {
        return this.getAt(position) !== null;
    }

    /** Returns the crate occupying a position, or null when it is free. */
    getAt(position) {
        return this.byPosition.get(positionKey(position)) ?? null;
    }

    /** Reconciles a successful PDDL push with the remembered crate position. */
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
 * Holds the other agents perceived on the map.
 */
class Agents {
    constructor() {
        /**
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOAgent>}
         */
        this.others = new Map();
    }

    /**
     * Replaces the perceived agents with the latest sensing.
     * An agent caught mid-move keeps its fractional coordinate: it is exact,
     * and it is what tells us that two tiles are locked instead of one.
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
     * Returns whether another agent occupies the given tile.
     * The server locks both the starting and the ending tile of a move, and it
     * reports the mover on a fractional coordinate in between, so both tiles
     * count as taken. For an agent standing still floor and ceil are the same
     * value and this is the plain equality check.
     * @param {{x: number, y: number}} position
     * @returns {boolean}
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

// Fallback until the server sends its own movement duration. Only affects how
// long the agent waits before giving up on a blocked tile, and for how long.
const DEFAULT_MOVEMENT_DURATION_MS = 1000;

// A blocked tile is granted the time of two moves: long enough for a neighbour
// that is only passing through, short enough not to stall behind one that
// stopped there.
const BLOCKING_AGENT_WAIT_MOVES = 2;

/**
 * Stores map data, game configuration and observation metadata used by the agent.
 */
class World {
    constructor() {
        /** Number of X coordinates in the map, not the maximum X coordinate. */
        this.width = 0;

        /** Number of Y coordinates in the map, not the maximum Y coordinate. */
        this.height = 0;

        /**
         * Tile positions observed in the latest sensing event.
         * @type {Set<string>}
         */
        this.visiblePositions = new Set();

        /**
         * Complete map topology keyed by coordinates.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>}
         */
        this.tiles = new Map();

        /**
         * Stores known spawner tiles and the time each one was last checked.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile & {lastCheckedAt: number, canReachOperationalDelivery: boolean}>}
         */
        this.spawners = new Map();

        /** @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile & {canReachOperationalSpawner: boolean}>} */
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
         * @type {number}
         */
        this.avgReward = -1;

        /**
         * @type {number}
         */
        this.rewardVariance = -1;
    }

    /** Applies the server game configuration.
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
     * Rebuilds the local map state from the latest map snapshot.
     * The received tiles are the authoritative source for both topology and dimensions.
     * Width and height are coordinate counts, not maximum valid coordinates.
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
     * Replaces the visible-position set with the latest sensing data.
     */
    updateVisiblePositions(positions) {
        this.visiblePositions.clear();

        for (const position of positions ?? []) {
            if (!isFinitePosition(position)) continue;
            this.visiblePositions.add(positionKey(position));
        }
    }

    /**
     * Returns whether a position was observed in the latest sensing event.
     */
    isVisible(position) {
        if (!isFinitePosition(position)) return false;
        return this.visiblePositions.has(positionKey(position));
    }

    /** Returns whether a tile can contain or receive a crate. */
    isCrateSpace(position) {
        const tile = this.tiles.get(positionKey(position));
        if (!tile) return false;
        const tileType = String(tile.type);
        return tileType === '5' || tileType === '5!';
    }

    /**
     * Updates the last-check time of spawners observed in the current sensing.
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
     * Returns the locally predicted reward loss during one movement.
     * A zero interval disables local extrapolation; the server may still decay rewards.
     * @returns {number} the locally predicted decay per movement
     */
    decayPerMove() {
        if (this.localDecayIntervalMs <= 0) return 0;
        return this.movementDuration / this.localDecayIntervalMs;
    }

    /**
     * How long to wait for another agent to clear a tile, in milliseconds.
     * Counted in movements so the wait scales with the speed of the game.
     * @returns {number} the wait in milliseconds
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
 * Aggregator that owns the belief components and wires them to the socket.
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
