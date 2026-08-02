import config from "../config.js";

const dbg = (...args) => {
    if (config.debug) console.log("[agent]", ...args);
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
 * @returns {Promise<ActionOutcome>} an object representing the SDK failure of an action.
 */
function sdkFailure(action, error) {
    const message = error instanceof Error ? error.message : String(error);
    dbg(`${action.action} failed: ${message}`);
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
                return sdkFailure(action, error);
            }
            if (result === false) {
                dbg(`move ${action.dir} failed: blocked`);
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
                return sdkFailure(action, error);
            }
            if (!Array.isArray(result) || result.length === 0) {
                dbg('pickup failed: no parcels');
                return { status: 'failed', action, result };
            }
            dbg('pickup succeeded');
            return { status: 'succeeded', action, result };
        }
        case 'putdown': {
            let result;
            try {
                result = await socket.emitPutdown();
            }
            catch (error) {
                return sdkFailure(action, error);
            }
            if (!Array.isArray(result) || result.length === 0) {
                dbg('putdown failed: no parcels');
                return { status: 'failed', action, result };
            }
            dbg('putdown succeeded');
            return { status: 'succeeded', action, result };
        }
        default:
            return { status: 'failed', action, result: null };
    }
}

/**
 * Tail of the queue below. It is deliberately a promise that never rejects:
 * a failed action must not poison every call made after it.
 * @type {Promise<void>}
 */
let pendingActions = Promise.resolve();

/**
 * Runs one action, waiting for the previous one to finish first.
 *
 * The server wraps each agent's actions in a mutex, and charges a penalty for
 * every action sent while the previous one is still running. Enough penalty
 * disconnects the agent and removes it from the grid. The agent has two callers
 * that act on the same socket, the BDI loop and the LLM tools, and they can
 * overlap while control is being handed over, so queueing here makes the
 * invariant automatic instead of something each caller has to remember.
 *
 * The queue is module state, which is agent state too: one process controls one
 * agent, so there is nothing to keep apart.
 *
 * The idle case is queued like any other. It waits on nothing meaningful, and
 * one path is simpler than a special case.
 * @param {import("./planning.js").Action | null} action
 * @param {import("./beliefs.js").Beliefs} beliefs
 * @param {object} socket
 * @returns {Promise<ActionOutcome>}
 */
export function executeAction(action, beliefs, socket) {
    const outcome = pendingActions.then(
        () => performAction(action, beliefs, socket)
    );
    pendingActions = outcome.then(() => undefined, () => undefined);
    return outcome;
}
