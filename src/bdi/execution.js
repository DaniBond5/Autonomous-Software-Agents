import config from "../config.js";

const dbg = (beliefs, ...args) => {
    if (config.debug) console.log(`[${beliefs.me.name || "agent"}]`, ...args);
};

/**
 * @typedef {Object} ActionOutcome
 * @property {'succeeded'|'failed'} status
 * @property {import("./planning.js").Action} action
 * @property {*} result original result returned by the server, or null
 * @property {*} [error] error raised by the SDK call
 */

function sdkFailure(action, error, beliefs) {
    const message = error instanceof Error ? error.message : String(error);
    dbg(beliefs, `${action.action} failed: ${message}`);
    return { status: 'failed', action, result: null, error };
}

// The BDI loop awaits every call, so this is the only physical actuator.
/** @returns {Promise<ActionOutcome>} */
export async function executeAction(action, beliefs, socket) {
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
            // TEMP diagnostic: action result shape.
            dbg(beliefs, `pickup result=${JSON.stringify(result)}`);
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
                const selected = typeof action.parcelId === 'string'
                    ? [action.parcelId]
                    : undefined;
                result = await socket.emitPutdown(selected);
            }
            catch (error) {
                return sdkFailure(action, error, beliefs);
            }
            // TEMP diagnostic: handoff putdown mismatch.
            dbg(
                beliefs,
                `putdown requested=${typeof action.parcelId === 'string'
                    ? action.parcelId
                    : 'all'} result=${JSON.stringify(result)}`
            );
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
