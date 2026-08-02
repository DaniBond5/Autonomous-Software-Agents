import {
    distanceFromSearch,
    shortestPathsFrom
} from "../utils/geometry.js";
import { RuleStore, applyRule } from "./rules.js";

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
     * This function adds parcels reported by the partner to the known map.
     * It is what lets an agent know about parcels lying outside its own sensing range.
     * An existing entry is never overwritten: the two agents share no clock, so there is no way to tell
     * whether a report is fresher than what we saw ourselves, and a first-hand observation is the better bet.
     * A wrong report costs nothing and repairs itself through the machinery that is already here:
     * `availableKnown` re-estimates the reward from `observedAt` and forgets the parcel once it decays to zero,
     * and `update` forgets it as soon as the reported position is observed without it.
     * @param {{id: string, x: number, y: number, reward: number}[]} reported
    */
    mergeReported(reported) {
        const observedAt = Date.now();

        for (const parcel of reported) {
            if (!parcel
                || typeof parcel.id !== 'string'
                || !isFinitePosition(parcel)
                || !Number.isFinite(parcel.reward)
                || parcel.reward <= 0) {
                continue;
            }

            if (this.known.has(parcel.id)
                || this.visible.has(parcel.id)
                || this.carried.has(parcel.id)) {
                continue;
            }

            this.known.set(parcel.id, {
                id: parcel.id,
                x: parcel.x,
                y: parcel.y,
                reward: parcel.reward,
                observedAt
            });
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
 * Version carried by every message the two agents exchange.
 * It costs one field and means a later protocol can be told apart from this one instead of guessed at.
*/
const PROTOCOL_VERSION = 1;

/**
 * This class represents what the agent believes about its teammate: who it is, and which parcel it has committed to.
 * Everything the two agents exchange is a belief, so the partner sits here beside the other belief components
 * and is revised in the same place as sensing.
 * It also owns the sending side of the protocol, because a belief about the partner is the only thing worth sending it.
*/
class Partner {
    constructor() {
        /**
         * The name the partner's token was created with, or null when the agent runs alone.
         * @type {string | null}
        */
        this.name = null;

        /**
         * The partner's agent id, assigned by the server and resolved from connection events, or null while unknown.
         * @type {string | null}
        */
        this.id = null;

        /**
         * The parcel the partner declared it is going for, with its distance to it, or null when it claims nothing.
         * @type {{parcelId: string, distance: number} | null}
        */
        this.claim = null;

        /**
         * The parcel this agent has declared to the partner. Kept so the claim can be repeated
         * to a partner that connected after it was made.
         * @type {{parcelId: string, distance: number} | null}
        */
        this.myClaim = null;

        /**
         * The parcel ids of the last report sent, or null when nothing has been sent yet.
         * @type {string | null}
        */
        this.sharedParcelIds = null;

        /**
         * @type {object | null}
        */
        this.socket = null;
    }

    /**
     * @returns {boolean} true when the partner's id has been resolved.
    */
    get isKnown() {
        return this.id !== null;
    }

    /**
     * This function records the partner's id once a connection event has identified it.
     * @param {string} id
    */
    connected(id) {
        this.id = id;
        console.log(`[partner] ${this.name} is agent ${id}`);

        // The partner missed whatever was said before it arrived. Forgetting the last report makes
        // the next sensing send one, and a claim already made is repeated here, so starting order does not matter.
        this.sharedParcelIds = null;
        if (this.myClaim) this.send({ kind: 'claim', ...this.myClaim });
    }

    /**
     * This function forgets the partner when it leaves the game.
    */
    disconnected() {
        console.log(`[partner] ${this.name} disconnected`);
        this.id = null;

        // A claim by an agent that is gone would keep a parcel reserved for nobody.
        this.claim = null;
    }

    /**
     * This function records what the partner declared. A claim for no parcel is a release.
     * @param {{parcelId: string, distance: number} | null} claim
    */
    setClaim(claim) {
        this.claim = claim;
        console.log(
            claim
                ? `[partner] claims parcel ${claim.parcelId} at distance ${claim.distance}`
                : "[partner] claims nothing"
        );
    }

    /**
     * This function sends the parcels the agent can see at this moment.
     * Only first-hand observations are ever sent: what the partner reported is never passed back.
     * That single rule is what keeps the protocol free of echo loops without message ids, hop counters or expiry times.
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} parcels
    */
    shareParcels(parcels) {
        if (!this.isKnown) return;

        const parcelIds = parcels.map(parcel => parcel.id).sort().join(",");
        // Sensing fires many times a second. The set of parcels is the only part worth resending:
        // rewards decay predictably and the receiver re-estimates them from the time of the report,
        // so a reward that changed on its own is not news and would only flood the chat.
        if (parcelIds === this.sharedParcelIds) return;
        this.sharedParcelIds = parcelIds;

        this.send({
            kind: 'parcels',
            parcels: parcels.map(({ id, x, y, reward }) => ({ id, x, y, reward }))
        });
    }

    /**
     * This function tells the partner which parcel the agent has committed to.
     * Only a pickup is a claim: delivering and exploring contend for nothing, so those and a missing
     * intention release the previous claim instead.
     * @param {import("./desires.js").Desire | null} intention
    */
    announceIntention(intention) {
        const isClaim = intention?.type === 'go_pick_up'
            && typeof intention.id === 'string'
            && Number.isFinite(intention.distance);
        const claim = isClaim
            ? { parcelId: intention.id, distance: intention.distance }
            : null;

        // Only the parcel is compared, not the distance. The distance shrinks with every step towards
        // the parcel, and resending that would be constant chatter to say something the partner can assume.
        if ((claim?.parcelId ?? null) === (this.myClaim?.parcelId ?? null)) return;
        this.myClaim = claim;

        this.send({
            kind: 'claim',
            parcelId: claim?.parcelId ?? null,
            distance: claim?.distance ?? null
        });
    }

    /**
     * This function passes a rule of the game on to the partner.
     * A mission is given to one agent but binds the team, and the partner has no other way
     * of hearing about it: the message it was sent went to one of us.
     * @param {object} rule a rule already accepted by this agent's own store
    */
    sendRule(rule) {
        this.send({ kind: 'rule', rule });
    }

    /**
     * This function checks whether a parcel should be left to the partner.
     * Both agents run this same comparison over the same two numbers, so exactly one of them yields.
     * The distances are BFS path lengths rather than straight lines, so the answer stays right
     * when a wall stands between the two agents and the parcel.
     * @param {string} parcelId
     * @param {number} myDistance the agent's own BFS distance to the parcel
     * @param {string} myId
     * @returns {boolean} true if the partner is closer and the parcel is its to take.
    */
    outbidsMeOn(parcelId, myDistance, myId) {
        if (this.claim?.parcelId !== parcelId) return false;
        if (this.claim.distance !== myDistance) return this.claim.distance < myDistance;

        // A tie has to break the same way on both sides. Without this, either both agents yield and
        // nobody collects the parcel, or neither does and both walk to it. Any total order on the ids works.
        return this.id < myId;
    }

    /**
     * This function sends one protocol message. It is internal to the class and does nothing while
     * the partner is unknown, which is also the case when the agent runs alone.
     * @param {{kind: string}} payload
    */
    send(payload) {
        if (!this.isKnown) return;
        this.socket.emitSay(this.id, { v: PROTOCOL_VERSION, ...payload });
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
        this.partner = new Partner();

        // Not sensing, but read by desire generation, pathfinding and intention revision,
        // all of which already receive beliefs. See the RuleStore comment for the trade-off.
        this.rules = new RuleStore();
    }

    /**
     * @param {object} socket
     * @param {{partnerName?: string | null}} [options] the name of the other agent, when there is one.
    */
    init(socket, { partnerName = null } = {}) {
        this.partner.name = partnerName;
        this.partner.socket = socket;

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

            // Only what this agent sees for itself, never what the partner reported. See Partner.shareParcels.
            this.partner.shareParcels(
                [...this.parcels.visible.values()].filter(
                    parcel => !parcel.carriedBy && parcel.reward > 0
                )
            );
        });

        // The partner's id is assigned by the server, so it cannot be agreed in advance or shared between
        // two processes. The server sends one of these events for every agent already connected and then
        // one per connection and disconnection, which resolves the id whichever agent starts first.
        socket.onAgentConnected((status, agent) => {
            if (!this.partner.name || agent?.name !== this.partner.name) return;

            // Our own event carries our own name back to us. It can arrive before `you`, and then me.id is
            // still empty and this does not fire: sharing a name with the partner is a misconfiguration,
            // and the warning below reports it.
            if (agent.id === this.me.id) return;

            if (status === 'connected') {
                if (this.partner.isKnown && this.partner.id !== agent.id) {
                    console.warn(
                        `[partner] two agents answer to ${agent.name}: keeping ${this.partner.id}, `
                        + `ignoring ${agent.id}. Check BDI_NAME and LLM_NAME`
                    );
                    return;
                }
                this.partner.connected(agent.id);
                return;
            }

            if (status === 'disconnected' && this.partner.id === agent.id) {
                this.partner.disconnected();
            }
        });

        // Chat carries both partner messages and whatever a human types, so a message is only revised into
        // a belief when it comes from the partner and is a protocol message this version understands.
        // The routing stays here rather than inside Partner: this class coordinates and delegates, and this
        // way Partner does not need to know that Parcels exists.
        socket.onMsg((senderId, _senderName, message) => {
            if (!this.partner.isKnown
                || senderId !== this.partner.id
                || message?.v !== PROTOCOL_VERSION) {
                return;
            }

            if (message.kind === 'parcels' && Array.isArray(message.parcels)) {
                this.parcels.mergeReported(message.parcels);
                return;
            }

            // A rule the partner was told about binds this agent too. It goes through the same
            // door as a rule from our own tools, so the two can never come to disagree about
            // which shapes are legal. A rule that does not validate is dropped in silence.
            if (message.kind === 'rule') {
                applyRule(this.rules, message.rule);
                return;
            }

            // A claim for no parcel is the release, so no third kind of message is needed.
            // Anything else is malformed and is dropped rather than acted on.
            if (message.kind === 'claim') {
                if (message.parcelId === null) {
                    this.partner.setClaim(null);
                } else if (typeof message.parcelId === 'string'
                    && Number.isFinite(message.distance)) {
                    this.partner.setClaim({
                        parcelId: message.parcelId,
                        distance: message.distance
                    });
                }
            }
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
