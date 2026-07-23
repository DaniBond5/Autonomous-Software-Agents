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

function sdkFailure(action, error) {
    const message = error instanceof Error ? error.message : String(error);
    dbg(`${action.action} failed: ${message}`);
    return { status: 'failed', action, result: null, error };
}

/**
 * Movement and self-position synchronization remain one operation.
 * @param {import("./planning.js").Action | null} action
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {object} socket
 * @returns {Promise<ActionOutcome>}
 */
export async function executeAction(action, beliefs, socket) {
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
