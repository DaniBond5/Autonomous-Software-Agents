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

function normalizeHandoffObjective(raw) {
    if (!isObject(raw) || raw.type !== "handoff") return null;

    const id = nonEmptyString(raw.id);
    const parcelId = nonEmptyString(raw.parcelId);
    const giverId = nonEmptyString(raw.giverId);
    const receiverId = nonEmptyString(raw.receiverId);
    const role = raw.role === "giver" || raw.role === "receiver"
        ? raw.role
        : null;
    const pointNames = [
        "parcelStart", "handoffTile", "waitTile", "exitTile", "deliveryTile"
    ];
    const points = pointNames.map(name => raw[name]);

    if (!id || !parcelId || !giverId || !receiverId
        || giverId === receiverId
        || !role
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

const resultHasParcel = (result, parcelId) => Array.isArray(result)
    && result.some(parcel => nonEmptyString(parcel?.id) === parcelId);

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
        }[objective.phase];
    }
    return objective.phase === "deliver"
        ? objective.deliveryTile
        : objective.waitTile;
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
            objective = {
                ...normalized,
                phase: normalized.role === "giver" ? "pickup" : "wait",
            };
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
            this._settleActive("failed", "handoff deadline expired");
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
        entry.resolve({
            objectiveId: entry.objective.id,
            status,
            reason: String(reason ?? ""),
        });
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
            this.settle(
                objective.id,
                "succeeded",
                `left handoff tile after dropping parcel ${objective.parcelId}`
            );
            return true;
        }
        return false;
    }

    reconcileAction(intention, outcome) {
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
            return this._reconcileHandoff(objective, actionType, outcome);
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

    _reconcileHandoff(objective, actionType, outcome) {
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
            || !resultHasParcel(outcome.result, objective.parcelId)) {
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
            objective.phase = objective.phase === "pickup" ? "drop" : "exit";
            return true;
        }
        if (objective.phase === "wait") {
            objective.phase = "deliver";
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
