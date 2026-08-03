import config from "../config.js";

// Both agents run this same code in one process, so every line says which of the two wrote
// it. The name comes from the token and is not known until the server sends it.
const dbg = (beliefs, ...args) => {
    if (config.debug) console.log(`[${beliefs.me.name || "agent"}]`, ...args);
};

/**
 * @typedef {Object} ActionOutcome
 * @property {'idle'|'succeeded'|'failed'} status
 * @property {import("./planning.js").Action | null} action
 * @property {*} result original result returned by the server, or null
 * @property {*} [error] error raised by the SDK call
 */

/**
 * This function returns an object containing the full information regarding an action that has failed.
 * The object will contain the status of the action (as failed), the action itself, a null result and the error given by the SDK.
 * @param {import("./planning.js").Action | null} action 
 * @param {*} error 
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @returns {Promise<ActionOutcome>} an object representing the SDK failure of an action.
 */
function sdkFailure(action, error, beliefs) {
    const message = error instanceof Error ? error.message : String(error);
    dbg(beliefs, `${action.action} failed: ${message}`);
    return { status: 'failed', action, result: null, error };
}

/**
 * This function executes the given action with a given agent's beliefs and the connection socket.
 * Movement and self-position synchronization are done with one operation.
 * @param {import("./planning.js").Action | null} action
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {object} socket
 * @returns {Promise<ActionOutcome>}
 */
async function performAction(action, beliefs, socket) {
    if (!action) return { status: 'idle', action: null, result: null };

    switch (action.action) {
        case 'move': {
            let result;
            try {
                result = await socket.emitMove(action.dir);
            }
            catch (error) {
                return sdkFailure(action, error, beliefs);
            }
            if (result === false) {
                dbg(beliefs, `move ${action.dir} failed: blocked`);
                return { status: 'failed', action, result };
            }
            beliefs.me.applyMovement(result);
            return { status: 'succeeded', action, result };
        }
        case 'pickup': {
            let result;
            try {
                result = await socket.emitPickup();
            }
            catch (error) {
                return sdkFailure(action, error, beliefs);
            }
            if (!Array.isArray(result) || result.length === 0) {
                dbg(beliefs, 'pickup failed: no parcels');
                return { status: 'failed', action, result };
            }
            dbg(beliefs, 'pickup succeeded');
            return { status: 'succeeded', action, result };
        }
        case 'putdown': {
            let result;
            try {
                result = await socket.emitPutdown();
            }
            catch (error) {
                return sdkFailure(action, error, beliefs);
            }
            if (!Array.isArray(result) || result.length === 0) {
                dbg(beliefs, 'putdown failed: no parcels');
                return { status: 'failed', action, result };
            }
            dbg(beliefs, 'putdown succeeded');
            return { status: 'succeeded', action, result };
        }
        default:
            return { status: 'failed', action, result: null };
    }
}

/**
 * Each socket has its own action queue.
 * An action waits only for the previous action sent through the same socket.
 * The stored queue never rejects, so one failed action cannot block later actions.
 * @type {WeakMap<object, Promise<void>>}
 */
const actionQueues = new WeakMap();

/**
 * Runs one action after earlier work on the same socket has finished.
 * The returned promise keeps the action outcome visible to the caller.
 * @param {import("./planning.js").Action | null} action
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {object} socket
 * @returns {Promise<ActionOutcome>}
 */
export function executeAction(action, beliefs, socket) {
    const previous = actionQueues.get(socket) ?? Promise.resolve();
    const outcome = previous.then(
        () => performAction(action, beliefs, socket)
    );
    actionQueues.set(
        socket,
        outcome.then(() => undefined, () => undefined)
    );
    return outcome;
}
