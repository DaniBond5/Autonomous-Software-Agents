// Explicit mission objectives must win over autonomous desires and temporary holds.
export const LLM_OBJECTIVE_UTILITY = 10_000;

const copyTarget = target => ({ x: target.x, y: target.y });
const isObject = value => value !== null
    && typeof value === "object"
    && !Array.isArray(value);
const isIntegerPoint = point =>
    Number.isInteger(point?.x) && Number.isInteger(point?.y);
const nonEmptyString = value =>
    typeof value === "string" && value.trim() ? value.trim() : null;
const areAdjacent = (first, second) =>
    Math.abs(first.x - second.x) + Math.abs(first.y - second.y) === 1;

export function normalizeHandoffObjective(raw) {
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
        || (raw.waitTile.x === raw.exitTile.x
            && raw.waitTile.y === raw.exitTile.y)
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

export class ObjectiveStore {
    constructor() {
        this.nextId = 1;

        /** @type {{objective: object, resolve: (result: object) => void} | null} */
        this.active = null;
    }

    /**
     * @param {{x: number, y: number}} target
     * @returns {{objective: object, completion: Promise<object>}}
     */
    requestGoTo(target) {
        if (!Number.isFinite(target?.x)
            || !Number.isFinite(target?.y)
            || !Number.isInteger(target.x)
            || !Number.isInteger(target.y)) {
            throw new TypeError("go_to target coordinates must be finite integers");
        }

        return this._request("go_to_tile", { target: copyTarget(target) });
    }

    /** @returns {{objective: object, completion: Promise<object>}} */
    requestPickup() {
        return this._request("pick_up_here");
    }

    /** @returns {{objective: object, completion: Promise<object>}} */
    requestPutdown() {
        return this._request("put_down_here");
    }

    requestHandoff(raw) {
        const normalized = normalizeHandoffObjective(raw);
        if (!normalized) throw new TypeError("invalid handoff objective");
        const { id, type, ...fields } = normalized;
        return this._request(type, {
            ...fields,
            phase: normalized.role === "giver" ? "pickup" : "wait",
        }, id);
    }

    /**
     * @param {'go_to_tile'|'pick_up_here'|'put_down_here'} type
     * @param {object} [fields]
     * @returns {{objective: object, completion: Promise<object>}}
     */
    _request(type, fields = {}, id = `llm-objective-${this.nextId++}`) {
        this.cancelActive("replaced by a new objective");

        const objective = {
            id,
            type,
            ...fields,
            utility: LLM_OBJECTIVE_UTILITY,
            status: "active",
        };
        let resolveCompletion;
        const completion = new Promise(resolve => {
            resolveCompletion = resolve;
        });
        this.active = { objective, resolve: resolveCompletion };
        return { objective, completion };
    }

    _expireActive() {
        const objective = this.active?.objective;
        if (objective?.type !== "handoff"
            || objective.expiresAt > Date.now()) return;
        this._settleActive("failed", "handoff deadline expired");
    }

    getActiveObjective() {
        this._expireActive();
        return this.active?.objective ?? null;
    }

    /** @returns {import("./desires.js").Desire | null} */
    getActiveDesire() {
        const objective = this.getActiveObjective();
        if (!objective) return null;
        const { id, status: _status, ...desire } = objective;
        desire.objectiveId = id;
        if (objective.target) desire.target = copyTarget(objective.target);
        return desire;
    }

    /** @param {string} objectiveId */
    isActive(objectiveId) {
        return this.getActiveObjective()?.id === objectiveId;
    }

    clear(objectiveId, reason = "objective cleared") {
        if (!this.isActive(objectiveId)) return false;
        return this.cancel(objectiveId, reason);
    }

    /** @param {string} objectiveId @param {string} reason */
    complete(objectiveId, reason) {
        return this.settle(objectiveId, "succeeded", reason);
    }

    /** @param {string} objectiveId @param {string} reason */
    fail(objectiveId, reason) {
        return this.settle(objectiveId, "failed", reason);
    }

    /** @param {string} objectiveId @param {string} reason */
    cancel(objectiveId, reason) {
        return this.settle(objectiveId, "cancelled", reason);
    }

    /** @param {string} reason */
    cancelActive(reason) {
        const objective = this.getActiveObjective();
        if (!objective) return false;
        return this.cancel(objective.id, reason);
    }

    /**
     * @param {string} objectiveId
     * @param {'succeeded'|'failed'|'cancelled'} status
     * @param {string} reason
     */
    settle(objectiveId, status, reason) {
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

    reconcileActionOutcome(intention, outcome) {
        const objectiveId = intention?.objectiveId;
        const objective = this.getActiveObjective();
        const actionType = outcome?.action?.action;
        if (!objectiveId || objective?.id !== objectiveId
            || outcome?.action?.objectiveId !== objectiveId
            || intention.type !== objective.type
            || (actionType !== "pickup" && actionType !== "putdown")) {
            return { handled: false, terminal: false };
        }

        if (objective.type !== "handoff") {
            return { handled: false, terminal: false };
        }
        const expectedAction = objective.role === "giver"
            ? { pickup: "pickup", drop: "putdown", exit: null }[objective.phase]
            : { wait: "pickup", deliver: "putdown" }[objective.phase];
        if (actionType !== expectedAction) {
            this.fail(objectiveId, "handoff action happened in the wrong phase");
            return { handled: true, terminal: true };
        }
        if (outcome.status !== "succeeded"
            || !resultHasParcel(outcome.result, objective.parcelId)) {
            this.fail(
                objectiveId,
                outcome.status === "failed"
                    ? actionFailureReason(outcome, `handoff ${actionType} failed`)
                    : `the selected parcel was not ${actionType === "pickup"
                        ? "picked up"
                        : "put down"}`
            );
            return { handled: true, terminal: true };
        }

        if (objective.role === "giver") {
            objective.phase = objective.phase === "pickup" ? "drop" : "exit";
            return { handled: true, terminal: false };
        }

        if (objective.phase === "wait") {
            objective.phase = "deliver";
            return { handled: true, terminal: false };
        }

        this.complete(objectiveId, `delivered parcel ${objective.parcelId}`);
        return { handled: true, terminal: true };
    }
}
