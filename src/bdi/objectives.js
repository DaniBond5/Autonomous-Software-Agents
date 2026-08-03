// Explicit mission objectives must win over autonomous desires and temporary holds.
export const LLM_OBJECTIVE_UTILITY = 10_000;

const copyTarget = target => ({ x: target.x, y: target.y });

/**
 * Stores the single physical objective currently requested by the LLM.
 * The LLM publishes it, the BDI loop consumes it, and the completion promise
 * carries the BDI result back to the waiting tool call.
 */
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

    /**
     * @param {'go_to_tile'|'pick_up_here'|'put_down_here'} type
     * @param {object} [fields]
     * @returns {{objective: object, completion: Promise<object>}}
     */
    _request(type, fields = {}) {
        this.cancelActive("replaced by a new objective");

        const objective = {
            id: `llm-objective-${this.nextId++}`,
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

    /** @returns {import("./desires.js").Desire | null} */
    getActiveDesire() {
        if (!this.active) return null;
        const { objective } = this.active;
        const desire = {
            type: objective.type,
            utility: objective.utility,
            objectiveId: objective.id,
        };
        if (objective.target) desire.target = copyTarget(objective.target);
        return desire;
    }

    /** @param {string} objectiveId */
    isActive(objectiveId) {
        return this.active?.objective.id === objectiveId;
    }

    /**
     * @param {string} objectiveId
     * @param {string} reason
     */
    complete(objectiveId, reason) {
        return this.settle(objectiveId, "succeeded", reason);
    }

    /**
     * @param {string} objectiveId
     * @param {string} reason
     */
    fail(objectiveId, reason) {
        return this.settle(objectiveId, "failed", reason);
    }

    /**
     * @param {string} objectiveId
     * @param {string} reason
     */
    cancel(objectiveId, reason) {
        return this.settle(objectiveId, "cancelled", reason);
    }

    /** @param {string} reason */
    cancelActive(reason) {
        if (!this.active) return false;
        return this.cancel(this.active.objective.id, reason);
    }

    /**
     * @param {string} objectiveId
     * @param {'succeeded'|'failed'|'cancelled'} status
     * @param {string} reason
     */
    settle(objectiveId, status, reason) {
        if (!this.isActive(objectiveId)) return false;

        const entry = this.active;
        this.active = null;
        entry.objective.status = status;
        entry.resolve({ objectiveId, status, reason: String(reason ?? "") });
        return true;
    }
}
