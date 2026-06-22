import { generateDesires } from "./desires.js";
import { BFS } from "../utils/geometry.js";

/**
 * @typedef {{action:'move',dir:'up'|'down'|'left'|'right'}|{action:'pickup'}|{action:'putdown'}} Action
 */

const roundPos = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

/* ------------------------------------------------------------------ */
/* DELIBERATION: what to pursue                                       */
/* ------------------------------------------------------------------ */

/**
 * Out of all current desires, pick the one with the highest utility.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {import("./desires.js").Desire | null}
 */
export function selectIntention(beliefs) {
    const desires = generateDesires(beliefs);
    if (desires.length === 0) return null;

    let best = desires[0];
    for (const d of desires) {
        if (d.utility > best.utility) best = d;
    }
    return best;
}

/* ------------------------------------------------------------------ */
/* PLANNING: how to reach it (BFS now; PDDL will slot in here later)  */
/* ------------------------------------------------------------------ */

/** Direction from `a` to an ADJACENT tile `b`. up = y+1, down = y-1. */
function stepDir(a, b) {
    if (b.x > a.x) return 'right';
    if (b.x < a.x) return 'left';
    if (b.y > a.y) return 'up';
    if (b.y < a.y) return 'down';
    return null;
}

/**
 * Navigate one step toward the target using BFS; emit `terminal` once arrived.
 * Returns only the FIRST move of the path — the executor re-plans each cycle.
 */
function navigateThen(terminal, intention, beliefs) {
    const path = BFS(beliefs, { x: intention.target.x, y: intention.target.y });
    if (path === false) {
        console.log(`[plan] no path to (${intention.target.x},${intention.target.y})`);
        return []; // unreachable → empty plan; executor will re-deliberate
    }
    if (path.length === 0) return terminal ? [terminal] : []; // already arrived

    const me = roundPos(beliefs.me.pos);
    const dir = stepDir(me, path[0]); // path[0] is always adjacent to me
    if (dir === null) return terminal ? [terminal] : [];
    return [{ action: 'move', dir }];
}

/**
 * Plan library, keyed by desire type. Adding a behaviour = adding an entry.
 * This is the "select plans from a library" step; refactorable to a
 * Chain of Responsibility later, once the handlers grow.
 */
const planners = {
    go_pick_up:    (i, b) => navigateThen({ action: 'pickup' }, i, b),
    go_deliver:    (i, b) => navigateThen({ action: 'putdown' }, i, b),
    go_to_spawner: (i, b) => navigateThen(null, i, b),
};

/**
 * Planning step: turn an intention into a sequence of abstract actions.
 * BFS/PDDL can change WHAT is returned here without touching the executor.
 * @param {import("./desires.js").Desire} intention
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {Action[]}
 */
export function planFor(intention, beliefs) {
    const planner = planners[intention.type];
    if (!planner) {
        console.warn(`[planFor] no planner for type ${intention.type}`);
        return [];
    }
    return planner(intention, beliefs);
}

/* ------------------------------------------------------------------ */
/* EXECUTION: do it (only this layer knows the SDK)                   */
/* ------------------------------------------------------------------ */

/** Maps one abstract action to the SDK. @returns {Promise<boolean>} acted */
async function executeAction(action, socket) {
    switch (action.action) {
        case 'move': {
            const result = await socket.emitMove(action.dir);
            if (!result) console.log(`[exec] move ${action.dir} failed`); // step 4 will retry
            return true;
        }
        case 'pickup':  await socket.emitPickup();  console.log('[exec] pickup');  return true;
        case 'putdown': await socket.emitPutdown(); console.log('[exec] putdown'); return true;
        default: return false;
    }
}

/**
 * Execution step: plan, then run only the FIRST action and return.
 * Re-planning happens next loop cycle — keeps the agent reactive.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {import("./desires.js").Desire} intention
 * @param {object} socket
 * @returns {Promise<boolean>} true if an action was executed
 */
export async function executeIntention(beliefs, intention, socket) {
    const plan = planFor(intention, beliefs);
    if (plan.length === 0) return false;
    return executeAction(plan[0], socket); // head only; re-plan next cycle
}