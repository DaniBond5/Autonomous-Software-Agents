import config from "../config.js";
import { trace } from "../utils/trace.js";
import { normalizeActionResultEntry } from "./beliefs.js";

const dbg = (...args) => {
    if (config.debug) console.log("[objective]", ...args);
};

// Temporary mission objectives outrank normal autonomous desires.
const LLM_OBJECTIVE_UTILITY = 10_000;

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const copyTarget = target => ({ x: target.x, y: target.y });
const isObject = value => value !== null
    && typeof value === "object"
    && !Array.isArray(value);
const isIntegerPoint = point =>
    Number.isInteger(point?.x) && Number.isInteger(point?.y);
const nonEmptyString = value =>
    typeof value === "string" && value.trim() ? value.trim() : null;
const samePosition = (first, second) => Boolean(
    first && second && first.x === second.x && first.y === second.y
);
const areAdjacent = (first, second) =>
    Math.abs(first.x - second.x) + Math.abs(first.y - second.y) === 1;

// A giver already carrying the parcel starts at "drop" instead of "pickup".
const HANDOFF_START_PHASES = {
    giver: new Set(["pickup", "drop"]),
    receiver: new Set(["wait"]),
};

function normalizeHandoffObjective(raw) {
    if (!isObject(raw) || raw.type !== "handoff") return null;

    const id = nonEmptyString(raw.id);
    const parcelId = nonEmptyString(raw.parcelId);
    const giverId = nonEmptyString(raw.giverId);
    const receiverId = nonEmptyString(raw.receiverId);
    const role = raw.role === "giver" || raw.role === "receiver"
        ? raw.role
        : null;
    const startPhase = role && HANDOFF_START_PHASES[role].has(raw.startPhase)
        ? raw.startPhase
        : null;
    // Identifies the other role's objective, so a stale result cannot be
    // mistaken for this exchange's counterpart.
    const peerObjectiveId = nonEmptyString(raw.peerObjectiveId);
    const pointNames = [
        "parcelStart", "handoffTile", "waitTile", "exitTile", "deliveryTile"
    ];
    const points = pointNames.map(name => raw[name]);

    if (!id || !parcelId || !giverId || !receiverId
        || giverId === receiverId
        || !role
        || !startPhase
        || !peerObjectiveId
        || peerObjectiveId === id
        || points.some(point => !isIntegerPoint(point))
        || !areAdjacent(raw.parcelStart, raw.handoffTile)
        || samePosition(raw.parcelStart, raw.waitTile)
        || samePosition(raw.waitTile, raw.exitTile)
        || !areAdjacent(raw.handoffTile, raw.waitTile)
        || !areAdjacent(raw.handoffTile, raw.exitTile)
        || !Number.isFinite(raw.expiresAt)
        || raw.expiresAt <= Date.now()) {
        return null;
    }

    return {
        id,
        type: "handoff",
        role,
        startPhase,
        peerObjectiveId,
        parcelId,
        giverId,
        receiverId,
        parcelStart: copyTarget(raw.parcelStart),
        handoffTile: copyTarget(raw.handoffTile),
        waitTile: copyTarget(raw.waitTile),
        exitTile: copyTarget(raw.exitTile),
        deliveryTile: copyTarget(raw.deliveryTile),
        expiresAt: raw.expiresAt,
    };
}

// A targeted action moves exactly one parcel, so the tile it ended up on
// identifies it when the server answers without ids. The two actions differ
// only in carriage: a putdown leaves the parcel uncarried on that tile, while
// a pickup leaves it carried by whoever made the call, which is this agent.
const matchesByPosition = (entries, actionType, currentPosition) => {
    if (entries.length !== 1
        || !isIntegerPoint(currentPosition)
        || !samePosition(entries[0], currentPosition)) {
        return false;
    }
    if (actionType === "putdown") return !entries[0].carriedBy;
    if (actionType === "pickup") return Boolean(entries[0].carriedBy);
    return false;
};

const resultHasParcel = (result, parcelId, actionType, currentPosition) => {
    if (!Array.isArray(result)) return false;

    const entries = result
        .map(normalizeActionResultEntry)
        .filter(entry => entry !== null);
    const identified = entries.filter(entry => entry.id !== undefined);
    if (identified.length > 0) {
        return identified.some(entry => entry.id === parcelId);
    }
    if (!matchesByPosition(entries, actionType, currentPosition)) return false;

    trace("objective", `${actionType}-by-position`, {
        parcel: parcelId,
        at: `${currentPosition.x},${currentPosition.y}`
    });
    return true;
};

const actionFailureReason = (outcome, fallback) => {
    if (outcome?.error instanceof Error) return outcome.error.message;
    if (outcome?.error != null) return String(outcome.error);
    return fallback;
};

const handoffTarget = objective => {
    if (objective.role === "giver") {
        return {
            pickup: objective.parcelStart,
            drop: objective.handoffTile,
            exit: objective.exitTile,
            // Parked: the target it already stands on plans no action.
            hold: objective.exitTile,
        }[objective.phase];
    }
    return objective.phase === "deliver"
        ? objective.deliveryTile
        : objective.waitTile;
};

const objectiveTraceType = objective =>
    objective.hold === true ? "hold" : objective.type;

const traceHandoffPhase = (objective, from, to, reason) => {
    trace("objective", "phase", {
        id: objective.id,
        role: objective.role,
        from,
        to,
        parcel: objective.parcelId,
        reason
    });
};

export class ObjectiveStore {
    constructor() {
        this.nextId = 1;

        /** @type {{objective: object, resolve: (result: object) => void} | null} */
        this.active = null;
    }

    request(type, fields) {
        const objective = this._normalizeRequest(type, fields);
        this.cancelActive("replaced by a new objective");

        let resolveCompletion;
        const completion = new Promise(resolve => {
            resolveCompletion = resolve;
        });
        this.active = { objective, resolve: resolveCompletion };
        trace("objective", "start", {
            id: objective.id,
            type: objectiveTraceType(objective),
            role: objective.role,
            parcel: objective.parcelId,
            target: objective.target,
            expiresAt: objective.expiresAt
        });
        return { objective, completion };
    }

    _normalizeRequest(type, fields) {
        let objective;
        if (type === "go_to") {
            if (!isObject(fields) || !isIntegerPoint(fields.target)) {
                throw new TypeError("go_to target coordinates must be finite integers");
            }
            objective = {
                id: `llm-objective-${this.nextId++}`,
                type: "go_to_tile",
                target: copyTarget(fields.target),
            };
        } else if (type === "pickup" || type === "putdown") {
            if (fields !== undefined
                && (!isObject(fields) || Object.keys(fields).length > 0)) {
                throw new TypeError(`${type} does not accept fields`);
            }
            objective = {
                id: `llm-objective-${this.nextId++}`,
                type: type === "pickup" ? "pick_up_here" : "put_down_here",
            };
        } else if (type === "hold") {
            const id = nonEmptyString(fields?.id);
            if (!id
                || !Number.isInteger(fields?.x)
                || !Number.isInteger(fields?.y)
                || !Number.isFinite(fields?.seconds)
                || fields.seconds <= 0) {
                throw new TypeError(
                    "a hold needs an id, integer x and y, and positive seconds"
                );
            }
            objective = {
                id,
                type: "go_to_tile",
                target: { x: fields.x, y: fields.y },
                hold: true,
                expiresAt: Date.now() + fields.seconds * 1000,
            };
        } else if (type === "handoff") {
            const normalized = normalizeHandoffObjective({
                ...fields,
                type: "handoff",
            });
            if (!normalized) throw new TypeError("invalid handoff objective");
            // Only the runtime `phase` is kept: _reconcileHandoff advances it,
            // so a retained `startPhase` would soon contradict it.
            const { startPhase, ...rest } = normalized;
            objective = { ...rest, phase: startPhase };
        } else {
            throw new TypeError(`unsupported objective type: ${String(type)}`);
        }

        return {
            ...objective,
            utility: LLM_OBJECTIVE_UTILITY,
            status: "active",
        };
    }

    _expireActive() {
        const objective = this.active?.objective;
        if (!objective || objective.expiresAt > Date.now()) return;
        if (objective.hold === true) {
            this._settleActive("succeeded", "hold duration completed");
        } else if (objective.type === "handoff") {
            // A parked giver already dropped the parcel, so its own work stands
            // even when the receiver never reported back.
            const parkedGiver = objective.role === "giver"
                && objective.phase === "hold";
            this._settleActive(
                parkedGiver ? "succeeded" : "failed",
                parkedGiver
                    ? "handoff deadline expired while waiting for the receiver"
                    : "handoff deadline expired"
            );
        }
    }

    activeObjective() {
        this._expireActive();
        return this.active?.objective ?? null;
    }

    activeDesire() {
        const objective = this.activeObjective();
        if (!objective) return null;

        const { id, status: _status, ...desire } = objective;
        desire.objectiveId = id;
        const target = objective.type === "handoff"
            ? handoffTarget(objective)
            : objective.target;
        if (target) desire.target = copyTarget(target);
        return desire;
    }

    isActive(objectiveId) {
        return this.activeObjective()?.id === objectiveId;
    }

    // A targeted clear must not cancel a newer objective.
    clear(objectiveId, reason = "objective cleared") {
        if (!this.isActive(objectiveId)) return false;
        return this.settle(objectiveId, "cancelled", reason);
    }

    cancelActive(reason) {
        const objective = this.activeObjective();
        if (!objective) return false;
        return this.settle(objective.id, "cancelled", reason);
    }

    /**
     * Releases a giver parked on its exit tile once the receiver reports back.
     * A failed receiver releases it too: a giver frozen after a failure would
     * be worse than the re-grab this hold prevents. The giver always ends on
     * success, because its own drop happened; the exchange's verdict is the
     * receiver's result, which the caller reads directly.
     * @returns {boolean}
     */
    settleGiverHold(result) {
        const objective = this.activeObjective();
        if (objective?.type !== "handoff"
            || objective.role !== "giver"
            || objective.phase !== "hold"
            || result?.role !== "receiver"
            || !TERMINAL_STATUSES.has(result?.status)
            || nonEmptyString(result.id) !== objective.peerObjectiveId) {
            return false;
        }

        return this._settleActive(
            "succeeded",
            `receiver reported ${result.status}`
        );
    }

    settle(objectiveId, status, reason) {
        if (!TERMINAL_STATUSES.has(status)) return false;
        this._expireActive();
        if (this.active?.objective.id !== objectiveId) return false;
        return this._settleActive(status, reason);
    }

    _settleActive(status, reason) {
        if (!this.active) return false;
        const entry = this.active;
        this.active = null;
        entry.objective.status = status;
        const settledReason = String(reason ?? "");
        if (entry.objective.type === "handoff"
            && status === "succeeded"
            && (entry.objective.phase === "hold"
                || entry.objective.phase === "deliver")) {
            traceHandoffPhase(
                entry.objective,
                entry.objective.phase,
                "succeeded",
                settledReason
            );
        }
        const result = {
            objectiveId: entry.objective.id,
            status,
            reason: settledReason,
        };
        trace("objective", "complete", {
            id: entry.objective.id,
            type: objectiveTraceType(entry.objective),
            status,
            reason: result.reason
        });
        entry.resolve(result);
        return true;
    }

    reconcilePlanning(intention, planningResult, currentPosition) {
        const objective = this.activeObjective();
        if (!intention?.objectiveId) return false;
        if (objective?.id !== intention.objectiveId
            || objective.type !== intention.type) return true;

        if (planningResult?.status === "unreachable") {
            this.settle(
                objective.id,
                "failed",
                planningResult.reason || "target is unreachable"
            );
            return true;
        }
        if (planningResult?.status === "deferred") return true;
        if (planningResult?.status === "wait") return false;
        if (planningResult?.status !== "idle") return false;

        if (objective.hold === true) return false;
        if (objective.type === "go_to_tile"
            && samePosition(currentPosition, objective.target)) {
            this.settle(
                objective.id,
                "succeeded",
                `reached target (${objective.target.x},${objective.target.y})`
            );
            return true;
        }
        if (objective.type === "handoff"
            && objective.role === "giver"
            && objective.phase === "exit"
            && samePosition(currentPosition, objective.exitTile)) {
            // Staying parked keeps the dropped parcel out of reach of the
            // giver's own autonomous desires until the receiver is done.
            objective.phase = "hold";
            traceHandoffPhase(objective, "exit", "hold");
            return true;
        }
        return false;
    }

    reconcileAction(intention, outcome, currentPosition) {
        const objective = this.activeObjective();
        const objectiveId = intention?.objectiveId;
        const actionType = outcome?.action?.action;
        if (!objectiveId
            || objective?.id !== objectiveId
            || outcome?.action?.objectiveId !== objectiveId
            || intention.type !== objective.type
            || (actionType !== "pickup" && actionType !== "putdown")) {
            return false;
        }

        if (objective.type === "handoff") {
            return this._reconcileHandoff(
                objective, actionType, outcome, currentPosition
            );
        }

        const expectedAction = objective.type === "pick_up_here"
            ? "pickup"
            : objective.type === "put_down_here"
                ? "putdown"
                : null;
        if (actionType !== expectedAction) return false;

        const count = Array.isArray(outcome.result) ? outcome.result.length : 0;
        let status = "failed";
        let reason;
        if (outcome.status === "cancelled") {
            status = "cancelled";
            reason = actionFailureReason(outcome, `${actionType} cancelled`);
        } else if (count === 0
            && (Array.isArray(outcome.result) || outcome.status === "succeeded")) {
            reason = actionType === "pickup"
                ? "no parcels were picked up"
                : "no parcels were put down";
        } else if (outcome.status !== "succeeded") {
            reason = actionFailureReason(outcome, `${actionType} failed`);
        } else {
            status = "succeeded";
            const action = actionType === "pickup" ? "picked up" : "put down";
            const parcels = count === 1 ? "parcel" : "parcels";
            reason = `${action} ${count} ${parcels}`;
        }

        this.settle(objectiveId, status, reason);
        return true;
    }

    _reconcileHandoff(objective, actionType, outcome, currentPosition) {
        const expectedAction = objective.role === "giver"
            ? { pickup: "pickup", drop: "putdown", exit: null }[objective.phase]
            : { wait: "pickup", deliver: "putdown" }[objective.phase];
        if (actionType !== expectedAction) {
            this.settle(
                objective.id,
                "failed",
                "handoff action happened in the wrong phase"
            );
            return true;
        }
        if (outcome.status === "cancelled") {
            this.settle(
                objective.id,
                "cancelled",
                actionFailureReason(outcome, `handoff ${actionType} cancelled`)
            );
            return true;
        }
        if (outcome.status !== "succeeded"
            || !resultHasParcel(
                outcome.result,
                objective.parcelId,
                actionType,
                currentPosition
            )) {
            // A missing parcel and an id mismatch follow the same failure path.
            dbg(
                `handoff ${actionType} rejected expected=${objective.parcelId}`
                + ` status=${outcome.status}`
                + ` actual=${JSON.stringify(Array.isArray(outcome.result)
                    ? outcome.result.map(parcel => parcel?.id)
                    : outcome.result)}`
            );
            this.settle(
                objective.id,
                "failed",
                outcome.status === "failed"
                    ? actionFailureReason(outcome, `handoff ${actionType} failed`)
                    : `the selected parcel was not ${actionType === "pickup"
                        ? "picked up"
                        : "put down"}`
            );
            return true;
        }

        if (objective.role === "giver") {
            const previousPhase = objective.phase;
            objective.phase = previousPhase === "pickup" ? "drop" : "exit";
            traceHandoffPhase(objective, previousPhase, objective.phase);
            return true;
        }
        if (objective.phase === "wait") {
            const previousPhase = objective.phase;
            objective.phase = "deliver";
            traceHandoffPhase(objective, previousPhase, objective.phase);
            return true;
        }

        this.settle(
            objective.id,
            "succeeded",
            `delivered parcel ${objective.parcelId}`
        );
        return true;
    }
}
