import { generateDesires } from "./desires.js";
import { BFS } from "../utils/geometry.js";

const DEBUG = true; // set to false to silence all [agent] debug logs
const dbg = (...args) => { if (DEBUG) console.log("[agent]", ...args); };

/**
 * @typedef {{action:'move',dir:'up'|'down'|'left'|'right'}|{action:'pickup'}|{action:'putdown'}} Action
 */

const roundPos = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

/* ------------------------------------------------------------------ */
/* DELIBERATION: what to pursue                                       */
/* ------------------------------------------------------------------ */

/** Selects the desire with the highest utility from an existing set. */
function selectBestDesire(desires) {
    if (desires.length === 0) return null;

    let best = desires[0];
    for (const desire of desires) {
        if (desire.utility > best.utility) best = desire;
    }
    return best;
}

/**
 * Out of all current desires, pick the one with the highest utility.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {import("./desires.js").Desire | null}
 */
export function selectIntention(beliefs) {
    const desires = generateDesires(beliefs);
    return selectBestDesire(desires);
}

/**
 * Keeps the current intention while its goal is still valid, otherwise
 * replaces it with the currently most useful desire.
 * @param {import("./desires.js").Desire | null} currentIntention
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {import("./desires.js").Desire | null}
 */
export function reviseIntention(currentIntention, beliefs) {
    const desires = generateDesires(beliefs);

    if (currentIntention) {
        switch (currentIntention.type) {
            case 'go_pick_up': {
                const pickupStillAvailable = desires.some(desire =>
                    desire.type === 'go_pick_up' && desire.id === currentIntention.id
                );
                if (pickupStillAvailable) return currentIntention;
                break;
            }
            case 'go_deliver':
                if (beliefs.parcels.carried.size > 0) return currentIntention;
                break;
            case 'go_to_spawner': {
                const reachedTarget = beliefs.me.pos.x === currentIntention.target.x
                    && beliefs.me.pos.y === currentIntention.target.y;
                const pickupAvailable = desires.some(desire => desire.type === 'go_pick_up');
                if (!reachedTarget && beliefs.parcels.carried.size === 0 && !pickupAvailable) {
                    return currentIntention;
                }
                break;
            }
        }
    }

    return selectBestDesire(desires);
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
    const me = roundPos(beliefs.me.pos);
    const path = BFS(beliefs, { x: intention.target.x, y: intention.target.y });

    if (path === false) {
        dbg(`${intention.type}: NO PATH  me(${me.x},${me.y}) -> target(${intention.target.x},${intention.target.y})`);
        return [];
    }
    if (path.length === 0) {
        dbg(`${intention.type}: ARRIVED at (${me.x},${me.y}) -> ${terminal ? terminal.action : 'idle'}`);
        return terminal ? [terminal] : [];
    }

    const dir = stepDir(me, path[0]);
    dbg(`${intention.type}: me(${me.x},${me.y}) -> next(${path[0].x},${path[0].y}) dir=${dir} | target(${intention.target.x},${intention.target.y}) dist=${path.length}`);
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

/**
 * Maps one abstract action to the SDK. The 'move' case is the single point that
 * emits movement, so it also owns the position sync: move and self-position update
 * are one indivisible operation — no caller has to remember to sync.
 * @returns {Promise<boolean>} acted
 */
async function executeAction(action, beliefs, socket) {
    switch (action.action) {
        case 'move': {
            const result = await socket.emitMove(action.dir);
            if (!result) {
                dbg(`move ${action.dir} FAILED (blocked)`); // blocked; collision handling (next step) will replan
                return false;
            }
            beliefs.me.applyMovement(result); // authoritative position from ack; avoids stale-belief overshoot
            return true;
        }
        case 'pickup':  await socket.emitPickup();  dbg('PICKUP');  return true;
        case 'putdown': await socket.emitPutdown(); dbg('PUTDOWN'); return true;
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
    return executeAction(plan[0], beliefs, socket); // head only; re-plan next cycle
}
