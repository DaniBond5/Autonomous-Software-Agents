import { BFS } from "../utils/geometry.js";

const DEBUG = true; // set to false to silence all [agent] debug logs
const dbg = (...args) => { if (DEBUG) console.log("[agent]", ...args); };

/**
 * @typedef {{action:'move',dir:'up'|'down'|'left'|'right'}|{action:'pickup'}|{action:'putdown'}} Action
 */

const roundPos = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Direction from `a` to an ADJACENT tile `b`. up = y+1, down = y-1. */
function stepDir(a, b) {
    if (b.x > a.x) return 'right';
    if (b.x < a.x) return 'left';
    if (b.y > a.y) return 'up';
    if (b.y < a.y) return 'down';
    return null;
}

/**
 * Navigate one step toward the target; return `terminal` once arrived.
 * The next step is planned again on the following agent cycle.
 * @param {Action | null} terminal
 * @param {import("./desires.js").Desire} intention
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {Action | null}
 */
function navigateThen(terminal, intention, beliefs) {
    const me = roundPos(beliefs.me.pos);
    const path = BFS(beliefs, { x: intention.target.x, y: intention.target.y });

    if (path === false) {
        dbg(`${intention.type}: NO PATH  me(${me.x},${me.y}) -> target(${intention.target.x},${intention.target.y})`);
        return null;
    }
    if (path.length === 0) {
        dbg(`${intention.type}: ARRIVED at (${me.x},${me.y}) -> ${terminal ? terminal.action : 'idle'}`);
        return terminal;
    }

    const dir = stepDir(me, path[0]);
    dbg(`${intention.type}: me(${me.x},${me.y}) -> next(${path[0].x},${path[0].y}) dir=${dir} | target(${intention.target.x},${intention.target.y}) dist=${path.length}`);
    if (dir === null) return terminal;
    return { action: 'move', dir };
}

const planners = {
    go_pick_up:    (i, b) => navigateThen({ action: 'pickup' }, i, b),
    go_deliver:    (i, b) => navigateThen({ action: 'putdown' }, i, b),
    go_to_spawner: (i, b) => navigateThen(null, i, b),
};

/**
 * Converts an intention into the single action to execute in the current cycle.
 * @param {import("./desires.js").Desire} intention
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {Action | null}
 */
export function planNextAction(intention, beliefs) {
    const planner = planners[intention.type];
    if (!planner) {
        console.warn(`[planNextAction] no planner for type ${intention.type}`);
        return null;
    }
    return planner(intention, beliefs);
}
