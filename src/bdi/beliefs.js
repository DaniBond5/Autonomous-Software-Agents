import {
    distanceFromSearch,
    shortestPathsFrom
} from "../utils/geometry.js";
import { trace } from "../utils/trace.js";
import { RuleStore } from "./rules.js";

export const POSITION_KEY = ({ x, y }) => `${x},${y}`;

const isFinitePosition = position =>
    Number.isFinite(position?.x)
    && Number.isFinite(position?.y);

/** @returns {number} decay interval in milliseconds, or zero for no decay */
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

// Mark spawners and deliveries that do not trap the agent away from future work.
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

class Me {
    constructor() {
        this.id = "";

        this.name = "";

        this.pos = { x: -1, y: -1 };

        this.score = 0;
    }

    /** @param {{id:string,name:string,x:number,y:number,score:number}} agentData */
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

    /** @param {{x:number,y:number}} position */
    applyMovement({ x, y }) {
        this.pos.x = Math.round(x);
        this.pos.y = Math.round(y);
    }
}

/**
 * Action results are not shaped like sensed parcels: the position can arrive
 * nested under `xy`, and the id can be missing entirely.
 * @returns {object | null} the entry with a flat position, or null if unusable
 */
export function normalizeActionResultEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const { xy, id, x, y, ...rest } = raw;
    // A present `xy` decides the position on its own, malformed or not.
    const position = xy !== undefined ? xy : { x, y };
    const entry = { ...rest };

    // Leaving x and y out lets isFinitePosition reject the entry downstream.
    if (isFinitePosition(position)) {
        entry.x = Number(position.x);
        entry.y = Number(position.y);
    }
    // Never invent an id the server did not send.
    if (typeof id === 'string' && id.trim()) entry.id = id.trim();

    return entry;
}

/**
 * Action results carry no id, so a lone entry sitting on the agent's own tile
 * is attributed to the parcel the intention was acting on.
 *
 * The trade-off: if the intended parcel expired and a different one sat on that
 * tile, the wrong id is recorded for one tick, until onSensing rewrites
 * `carried` from first-hand observation. That is preferable to an absent
 * belief, which stalls the handoff protocol outright.
 * @returns {string | null}
 */
function resolveResultParcelId(entry, entryCount, mePos, intendedParcelId) {
    if (typeof entry?.id === 'string') return entry.id;

    // More than one entry, or a mismatched tile, makes the guess unsound.
    if (entryCount !== 1
        || typeof intendedParcelId !== 'string'
        || !intendedParcelId.trim()
        || !isFinitePosition(entry)
        || !isFinitePosition(mePos)
        || entry.x !== mePos.x
        || entry.y !== mePos.y) {
        return null;
    }
    return intendedParcelId.trim();
}

class Parcels {
    constructor() {
        /** @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel>} */
        this.visible = new Map();

        /**
         * Past observations remain until their tile is seen empty or their reward decays away.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel & {observedAt: number}>}
         */
        this.known = new Map();

        /** @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOParcel>} */
        this.carried = new Map();
    }

    /**
     * @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} perceivedParcels
     * @param {string} meId
     * @param {function({x:number,y:number}):boolean} isVisible
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
            if (parcel.carriedBy !== meId
                || !Number.isFinite(parcel.reward)
                || parcel.reward < 0) {
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
     * Reconciles the real server result before the next sensing update arrives.
     * @param {import("./execution.js").ActionOutcome} outcome
     * @param {string} meId
     * @param {{x:number,y:number}} mePos
     * @param {boolean} [isDelivery=false]
     * @param {string} [intendedParcelId] parcel the intention was acting on
     */
    reconcileActionOutcome(outcome, meId, mePos, isDelivery = false, intendedParcelId) {
        const actionType = outcome?.action?.action;
        if (outcome?.status !== 'succeeded'
            || (actionType !== 'pickup' && actionType !== 'putdown')
            || !Array.isArray(outcome.result)) return;

        const entries = outcome.result.map(normalizeActionResultEntry);

        if (actionType === 'putdown') {
            for (const resultParcel of entries) {
                const id = resolveResultParcelId(
                    resultParcel, entries.length, mePos, intendedParcelId
                );
                if (!id) continue;
                const carriedParcel = this.carried.get(id);
                this.visible.delete(id);
                this.known.delete(id);
                this.carried.delete(id);

                if (!isDelivery && carriedParcel && isFinitePosition(mePos)) {
                    const parcel = {
                        ...carriedParcel,
                        ...resultParcel,
                        x: mePos.x,
                        y: mePos.y,
                        carriedBy: null,
                    };
                    this.visible.set(id, parcel);
                    if (Number.isFinite(parcel.reward) && parcel.reward > 0) {
                        this.known.set(id, {
                            ...parcel,
                            observedAt: Date.now(),
                        });
                    }
                }
            }
            return;
        }

        for (const resultParcel of entries) {
            const id = resolveResultParcelId(
                resultParcel, entries.length, mePos, intendedParcelId
            );
            if (!id) continue;

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

            if (!meId
                || !Number.isFinite(parcel.reward)
                || !isFinitePosition(parcel)) {
                continue;
            }

            delete parcel.observedAt;
            // The result may not carry the id, so restate the resolved one.
            this.carried.set(id, { ...parcel, id, carriedBy: meId });
        }
    }

    /** @param {{id:string,x:number,y:number,reward:number}[]} reported */
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

            // First-hand beliefs win because the two agents do not share a clock.
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

    /** @returns {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} */
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

    /** @returns {number} */
    carriedScore() {
        let score = 0;
        for (const parcel of this.carried.values()) {
            score += parcel.reward;
        }
        return score;
    }
}

class Crates {
    constructor() {
        /** @type {Map<string, import("@unitn-asa/deliveroo-js-sdk/types/IOCrate.js").IOCrate>} */
        this.known = new Map();

        /**
         * Position index rebuilt from `known`, which remains the source of truth.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk/types/IOCrate.js").IOCrate>}
         */
        this.byPosition = new Map();
    }

    reindexByPosition() {
        this.byPosition.clear();
        for (const crate of this.known.values()) {
            this.byPosition.set(POSITION_KEY(crate), crate);
        }
    }

    /**
     * @param {import("@unitn-asa/deliveroo-js-sdk/types/IOSensing.js").IOCrate[]} perceivedCrates
     * @param {function({x:number,y:number}):boolean} isVisible
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

    isOccupied(position) {
        return this.getAt(position) !== null;
    }

    /** @returns {import("@unitn-asa/deliveroo-js-sdk/types/IOCrate.js").IOCrate | null} */
    getAt(position) {
        return this.byPosition.get(POSITION_KEY(position)) ?? null;
    }

    /** @param {import("./execution.js").ActionOutcome} outcome */
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

class Agents {
    constructor() {
        /** @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOAgent>} */
        this.others = new Map();
    }

    /** @param {import("@unitn-asa/deliveroo-js-sdk").IOAgent[]} perceivedAgents */
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

    isOccupied(position) {
        // Fractional sensing coordinates lock both endpoints of an agent's move.
        for (const agent of this.others.values()) {
            if (position.x >= Math.floor(agent.x)
                && position.x <= Math.ceil(agent.x)
                && position.y >= Math.floor(agent.y)
                && position.y <= Math.ceil(agent.y)) return true;
        }
        return false;
    }
}

const HANDOFF_RESULT_STATUSES = new Set([
    'succeeded', 'failed', 'cancelled'
]);
const TRACED_COORDINATION_KINDS = new Set([
    'strategy', 'hold', 'hold_clear',
    'handoff', 'handoff_result', 'handoff_clear'
]);

function traceCoordination(event, kind, fields = {}) {
    if (!TRACED_COORDINATION_KINDS.has(kind)) return;
    const nested = fields?.hold ?? fields?.objective;
    trace("coordination", event, {
        kind,
        id: fields?.id ?? nested?.id,
        role: fields?.role ?? nested?.role,
        parcel: fields?.parcelId ?? nested?.parcelId,
        status: fields?.status
    });
}

/**
 * @typedef {{x: number, y: number, carriedCount: number,
 *     carriedReward: number, carriedParcelIds: string[]}} PartnerState
 */

/**
 * @typedef {{id: string, role: 'giver' | 'receiver',
 *     status: string, reason: string}} HandoffResult
 */

/** @returns {string[] | null} a fresh trimmed, unique and sorted list */
function normalizeCarriedParcelIds(value) {
    if (!Array.isArray(value)) return null;

    const ids = new Set();
    for (const entry of value) {
        if (typeof entry !== 'string' || !entry.trim()) return null;
        ids.add(entry.trim());
    }
    return [...ids].sort();
}

/** @returns {PartnerState | null} */
function normalizePartnerState(state) {
    if (!isFinitePosition(state)
        || !Number.isInteger(state.carriedCount)
        || state.carriedCount < 0
        || !Number.isFinite(state.carriedReward)
        || state.carriedReward < 0) {
        return null;
    }

    // A count disagreeing with the ids leaves the carried parcels ambiguous.
    const carriedParcelIds = normalizeCarriedParcelIds(state.carriedParcelIds);
    if (!carriedParcelIds
        || carriedParcelIds.length !== state.carriedCount) {
        return null;
    }

    return {
        x: Number(state.x),
        y: Number(state.y),
        carriedCount: state.carriedCount,
        carriedReward: Number(state.carriedReward),
        carriedParcelIds
    };
}

/** Holds partner state and the small peer protocol built on it. */
class Partner {
    constructor(me) {
        this.me = me;

        /** @type {string | null} */
        this.id = null;

        /** @type {(PartnerState & {receivedAt: number}) | null} */
        this.state = null;

        /** @type {PartnerState | null} */
        this.myState = null;

        // One slot per role, so a giver result never masks a receiver result.
        /** @type {{giver: HandoffResult | null, receiver: HandoffResult | null}} */
        this.handoffResults = { giver: null, receiver: null };

        /** @type {string | null} */
        this.sharedStateFingerprint = null;

        /** @type {{parcelId: string, distance: number} | null} */
        this.claim = null;

        /** Saved so a late-connected partner receives the current claim. */
        /** @type {{parcelId: string, distance: number} | null} */
        this.myClaim = null;

        /** @type {string | null} */
        this.sharedParcelIds = null;

        /** @type {object | null} */
        this.socket = null;
    }

    get isKnown() {
        return this.id !== null;
    }

    connected(id) {
        this.id = id;
        console.log(`[${this.me.name || "agent"}] partner is agent ${id}`);

        this.sharedParcelIds = null;
        this.sharedStateFingerprint = null;

        const connectedId = id;
        // The launcher connects both partners in the same synchronous block.
        // Send saved data afterwards, when both receivers know the partner id.
        queueMicrotask(() => {
            if (this.id !== connectedId) return;

            if (this.myState) this.shareState(this.myState);
            if (this.myClaim) this.send("claim", this.myClaim);
        });
    }

    // Removing a disconnected partner's claim prevents a permanent reservation.
    disconnected() {
        console.log(`[${this.me.name || "agent"}] partner disconnected`);
        this.id = null;
        this.state = null;
        this.handoffResults = { giver: null, receiver: null };
        this.sharedStateFingerprint = null;

        this.claim = null;
    }

    /** @returns {boolean} */
    setState(state) {
        const normalized = normalizePartnerState(state);
        if (!normalized) return false;
        this.state = { ...normalized, receivedAt: Date.now() };
        return true;
    }

    /** @returns {boolean} */
    setHandoffResult(result) {
        const id = typeof result?.id === 'string' ? result.id.trim() : '';
        const role = result?.role === 'giver' || result?.role === 'receiver'
            ? result.role
            : null;
        if (!id || !role || !HANDOFF_RESULT_STATUSES.has(result?.status)) {
            return false;
        }

        this.handoffResults[role] = {
            id,
            role,
            status: result.status,
            reason: String(result.reason ?? '')
        };
        return true;
    }

    /**
     * Matching both role and id keeps a stale result out of a later handoff.
     * @returns {HandoffResult | null}
     */
    handoffResultFor(role, objectiveId) {
        const result = this.handoffResults[role] ?? null;
        return result?.id === objectiveId ? result : null;
    }

    /** @param {PartnerState} state */
    shareState(state) {
        const normalized = normalizePartnerState(state);
        if (!normalized) return;
        this.myState = normalized;
        if (!this.isKnown) return;

        // The carried ids change even when count and reward stay the same.
        const fingerprint = `${normalized.x},${normalized.y},`
            + `${normalized.carriedCount},${normalized.carriedReward},`
            + JSON.stringify(normalized.carriedParcelIds);
        if (fingerprint === this.sharedStateFingerprint) return;
        this.sharedStateFingerprint = fingerprint;

        this.send("state", normalized);
    }

    /** @param {{parcelId:string,distance:number} | null} claim */
    setClaim(claim) {
        this.claim = claim;
        const me = this.me.name || "agent";
        console.log(
            claim
                ? `[${me}] partner claims parcel ${claim.parcelId} at distance ${claim.distance}`
                : `[${me}] partner claims nothing`
        );
    }

    /** @param {import("@unitn-asa/deliveroo-js-sdk").IOParcel[]} parcels */
    shareParcels(parcels) {
        if (!this.isKnown) return;

        const parcelIds = parcels.map(parcel => parcel.id).sort().join(",");
        // Send only first-hand parcels, never parcels received from the teammate.
        // Reward decay is predictable, so resend only when parcel ids change.
        if (parcelIds === this.sharedParcelIds) return;
        this.sharedParcelIds = parcelIds;

        this.send("parcels", {
            parcels: parcels.map(({ id, x, y, reward }) => ({ id, x, y, reward }))
        });
    }

    /** @param {import("./desires.js").Desire | null} intention */
    announceIntention(intention) {
        // Only pickups claim a contested resource; other intentions release it.
        const isClaim = intention?.type === 'go_pick_up'
            && typeof intention.id === 'string'
            && Number.isFinite(intention.distance);
        const claim = isClaim
            ? { parcelId: intention.id, distance: intention.distance }
            : null;

        // Distance changes every step; only a parcel change is worth resending.
        if ((claim?.parcelId ?? null) === (this.myClaim?.parcelId ?? null)) return;
        this.myClaim = claim;

        this.send("claim", {
            parcelId: claim?.parcelId ?? null,
            distance: claim?.distance ?? null
        });
    }

    /** @returns {boolean} */
    outbidsMeOn(parcelId, myDistance, myId) {
        // BFS distances keep the comparison valid across walls.
        if (this.claim?.parcelId !== parcelId) return false;
        if (this.claim.distance !== myDistance) return this.claim.distance < myDistance;

        // Both agents use the same id order to break equal-distance claims.
        return this.id < myId;
    }

    /** @param {string} kind */
    send(kind, fields = {}) {
        if (!this.isKnown || typeof kind !== 'string' || !kind) return;
        this.socket.emitSay(this.id, { ...fields, kind });
        traceCoordination("send", kind, fields);
    }
}

const DEFAULT_MOVEMENT_DURATION_MS = 1000;

const BLOCKING_AGENT_WAIT_MOVES = 2;

class World {
    constructor() {
        /** Number of X coordinates in the map, not the maximum X coordinate. */
        this.width = 0;

        /** Number of Y coordinates in the map, not the maximum Y coordinate. */
        this.height = 0;

        /** @type {Set<string>} */
        this.visiblePositions = new Set();

        /** @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile>} */
        this.tiles = new Map();

        /**
         * Operational spawners can still reach a delivery that does not trap the agent.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile & {lastCheckedAt: number, canReachOperationalDelivery: boolean}>}
         */
        this.spawners = new Map();

        /**
         * Operational deliveries can return to an operational spawner.
         * @type {Map<string, import("@unitn-asa/deliveroo-js-sdk").IOTile & {canReachOperationalSpawner: boolean}>}
         */
        this.deliveries = new Map();

        this.movementDuration = -1;

        this.observationDistance = -1;

        /** Local decay extrapolation interval in ms; 0 disables local extrapolation. */
        this.localDecayIntervalMs = 0;

        this.avgReward = -1;

        this.rewardVariance = -1;
    }

    /** @param {import("@unitn-asa/deliveroo-js-sdk/types/IOConfig.js").IOConfig} config */
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

    // Received tiles define the topology; dimensions are coordinate counts.
    /** @param {import("@unitn-asa/deliveroo-js-sdk").IOTile[]} tileset */
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

    updateVisiblePositions(positions) {
        this.visiblePositions.clear();

        for (const position of positions ?? []) {
            if (!isFinitePosition(position)) continue;
            this.visiblePositions.add(POSITION_KEY(position));
        }
    }

    /** @returns {boolean} */
    isVisible(position) {
        if (!isFinitePosition(position)) return false;
        return this.visiblePositions.has(POSITION_KEY(position));
    }

    /** @returns {boolean} */
    isCrateSpace(position) {
        const tile = this.tiles.get(POSITION_KEY(position));
        if (!tile) return false;
        const tileType = String(tile.type);
        return tileType === '5' || tileType === '5!';
    }

    markVisibleSpawners() {
        const checkedAt = Date.now();
        for (const spawner of this.spawners.values()) {
            if (this.isVisible(spawner)) {
                spawner.lastCheckedAt = checkedAt;
            }
        }
    }

    // A zero interval disables local decay extrapolation.
    /** @returns {number} */
    decayPerMove() {
        if (this.localDecayIntervalMs <= 0) return 0;
        return this.movementDuration / this.localDecayIntervalMs;
    }

    /** @returns {number} */
    movementDurationMs() {
        return Number.isFinite(this.movementDuration)
            && this.movementDuration > 0
            ? this.movementDuration
            : DEFAULT_MOVEMENT_DURATION_MS;
    }

    /** @returns {number} */
    blockingAgentWaitMs() {
        return this.movementDurationMs() * BLOCKING_AGENT_WAIT_MOVES;
    }
}

/** Owns one agent's belief components and socket listeners. */
export class Beliefs {
    constructor() {
        this.me = new Me();
        this.parcels = new Parcels();
        this.crates = new Crates();
        this.agents = new Agents();
        this.world = new World();
        this.partner = new Partner(this.me);

        // Policies persist here; temporary mission objectives live in ObjectiveStore.
        this.rules = new RuleStore();
    }

    shareCurrentState() {
        if (!isFinitePosition(this.me.pos)
            || this.me.pos.x < 0
            || this.me.pos.y < 0) return;

        this.partner.shareState({
            x: this.me.pos.x,
            y: this.me.pos.y,
            carriedCount: this.parcels.carried.size,
            carriedReward: this.parcels.carriedScore(),
            carriedParcelIds: [...this.parcels.carried.keys()]
        });
    }

    /**
     * @param {object} socket
     * @param {{objectives?: import("./objectives.js").ObjectiveStore | null}} [options]
     */
    init(socket, { objectives = null } = {}) {
        this.partner.socket = socket;

        socket.onYou((payload) => {
            this.me.update(payload);
            this.shareCurrentState();
        });

        socket.onSensing((sensing) => {
            this.world.updateVisiblePositions(sensing.positions ?? []);
            const isVisible = position => this.world.isVisible(position);
            this.parcels.update(
                sensing.parcels ?? [],
                this.me.id,
                isVisible
            );
            this.shareCurrentState();
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

        socket.onMsg((senderId, _senderName, message) => {
            if (!this.partner.isKnown
                || senderId !== this.partner.id
                || !message
                || typeof message !== 'object'
                || Array.isArray(message)
                || typeof message.kind !== 'string') {
                return;
            }

            switch (message.kind) {
                case 'state':
                    this.partner.setState(message);
                    return;
                case 'parcels':
                    if (Array.isArray(message.parcels)) {
                        this.parcels.mergeReported(message.parcels);
                    }
                    return;
                case 'strategy':
                    // Remote strategies are applied locally and are not echoed back.
                    if (this.rules.apply(message.operation).ok) {
                        traceCoordination("receive", message.kind, message);
                    }
                    return;
                case 'hold':
                    if (!objectives) return;
                    try {
                        objectives.request("hold", message.hold);
                        traceCoordination("receive", message.kind, message);
                    } catch {}
                    return;
                case 'hold_clear':
                    if (objectives
                        && typeof message.id === 'string'
                        && message.id.trim()) {
                        traceCoordination("receive", message.kind, message);
                        objectives.clear(
                            message.id.trim(),
                            "hold cleared by partner"
                        );
                    }
                    return;
                case 'handoff': {
                    const objective = message.objective;
                    if (!objective
                        || typeof objective !== 'object'
                        || Array.isArray(objective)
                        || !objectives) return;

                    // Accept either role, but only for the configured pair.
                    const assignedToMe = objective.role === 'giver'
                        ? objective.giverId === this.me.id
                            && objective.receiverId === this.partner.id
                        : objective.role === 'receiver'
                            && objective.receiverId === this.me.id
                            && objective.giverId === this.partner.id;
                    if (!assignedToMe) return;

                    try {
                        const { objective: accepted, completion } =
                            objectives.request("handoff", objective);
                        traceCoordination("receive", message.kind, message);
                        void completion.then(result => {
                            this.partner.send("handoff_result", {
                                id: result.objectiveId,
                                role: accepted.role,
                                status: result.status,
                                reason: result.reason
                            });
                        });
                    } catch (error) {
                        const id = typeof objective.id === 'string'
                            ? objective.id.trim()
                            : '';
                        console.warn(
                            `[${this.me.name || 'agent'}] rejected handoff objective`
                            + `${id ? ` ${id}` : ''}: `
                            + `${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                    return;
                }
                case 'handoff_result':
                    if (this.partner.setHandoffResult(message)) {
                        traceCoordination("receive", message.kind, message);
                    }
                    return;
                case 'handoff_clear':
                    if (objectives
                        && typeof message.id === 'string'
                        && message.id.trim()) {
                        traceCoordination("receive", message.kind, message);
                        objectives.clear(
                            message.id.trim(),
                            "handoff cleared by partner"
                        );
                    }
                    return;
                case 'claim':
                    if (message.parcelId === null) {
                        this.partner.setClaim(null);
                    } else if (typeof message.parcelId === 'string'
                        && Number.isFinite(message.distance)) {
                        this.partner.setClaim({
                            parcelId: message.parcelId,
                            distance: message.distance
                        });
                    }
                    return;
                default:
                    return;
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
