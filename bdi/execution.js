const DEBUG = true; // set to false to silence all [agent] debug logs
const dbg = (...args) => { if (DEBUG) console.log("[agent]", ...args); };

/**
 * Executes one planned action through the SDK.
 * Movement and self-position synchronization remain one operation.
 * @param {import("./planning.js").Action | null} action
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {object} socket
 * @returns {Promise<boolean>} true if an action was executed
 */
export async function executeAction(action, beliefs, socket) {
    if (!action) return false;

    switch (action.action) {
        case 'move': {
            const result = await socket.emitMove(action.dir);
            if (!result) {
                dbg(`move ${action.dir} FAILED (blocked)`);
                return false;
            }
            beliefs.me.applyMovement(result);
            return true;
        }
        case 'pickup':  await socket.emitPickup();  dbg('PICKUP');  return true;
        case 'putdown': await socket.emitPutdown(); dbg('PUTDOWN'); return true;
        default: return false;
    }
}
