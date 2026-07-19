import { BFS } from "../utils/geometry.js";

const DEBUG = true; // set to false to silence all [agent] debug logs
const dbg = (...args) => { if (DEBUG) console.log("[agent]", ...args); };

/**
 * @typedef {{action:'move',dir:'up'|'down'|'left'|'right'}|{action:'pickup'}|{action:'putdown'}} Action
 */

const roundPos = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

/**
 * @typedef {Object} ActiveDetour
 * @property {string} intentionKey
 * @property {{x: number, y: number}} currentPosition
 * @property {{x: number, y: number}[]} remainingPath
 */

/** @type {ActiveDetour | null} */
let activeDetour = null;

const samePosition = (a, b) => a.x === b.x && a.y === b.y;

/** Returns a stable key for desires regenerated across agent cycles. */
function intentionKey(intention) {
    return `${intention.type}:${intention.id ?? ''}:${intention.target.x},${intention.target.y}`;
}

/** Direction from `a` to an ADJACENT tile `b`. up = y+1, down = y-1. */
function stepDir(a, b) {
    if (b.x > a.x) return 'right';
    if (b.x < a.x) return 'left';
    if (b.y > a.y) return 'up';
    if (b.y < a.y) return 'down';
    return null;
}

/**
 * Known crates block the entire ordinary path. Other agents block only the
 * next move, while a dynamic detour persists until completion or invalidation.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {import("./desires.js").Desire} intention
 * @returns {false | {x: number, y: number}[]}
 */
function findOperationalPath(beliefs, intention) {
    const target = intention.target;
    const currentPosition = roundPos(beliefs.me.pos);
    const isCrateBlocked = position =>
        beliefs.crates.isOccupied(position);
    const isBlockedForDetour = (position) => {
        const isAdjacent = Math.abs(position.x - currentPosition.x)
            + Math.abs(position.y - currentPosition.y) === 1;
        return isCrateBlocked(position)
            || (isAdjacent && beliefs.agents.isOccupied(position));
    };
    const currentIntentionKey = intentionKey(intention);

    if (activeDetour?.intentionKey !== currentIntentionKey) {
        activeDetour = null;
    }

    if (activeDetour) {
        const expectedPosition = activeDetour.remainingPath[0];

        if (samePosition(currentPosition, activeDetour.currentPosition)) {
            // The previous movement did not advance: keep the complete remaining path.
        } else if (expectedPosition && samePosition(currentPosition, expectedPosition)) {
            activeDetour.remainingPath.shift();
            activeDetour.currentPosition = currentPosition;
        } else {
            activeDetour = null;
        }
    }

    if (activeDetour) {
        if (activeDetour.remainingPath.length === 0) {
            activeDetour = null;
            return [];
        }

        if (
            isCrateBlocked(activeDetour.remainingPath[0])
            || beliefs.agents.isOccupied(activeDetour.remainingPath[0])
        ) {
            const replannedDetour = BFS(beliefs, target, {
                isBlocked: isBlockedForDetour,
            });

            if (replannedDetour === false) return false;
            if (replannedDetour.length === 0) {
                activeDetour = null;
                return [];
            }

            activeDetour.currentPosition = currentPosition;
            activeDetour.remainingPath = [...replannedDetour];
        }

        return activeDetour.remainingPath;
    }

    const crateAwarePath = BFS(beliefs, target, {
        isBlocked: isCrateBlocked,
    });
    if (crateAwarePath === false || crateAwarePath.length === 0) return crateAwarePath;
    if (!beliefs.agents.isOccupied(crateAwarePath[0])) return crateAwarePath;

    const detour = BFS(beliefs, target, {
        isBlocked: isBlockedForDetour,
    });
    if (detour === false || detour.length === 0) return detour;

    activeDetour = {
        intentionKey: currentIntentionKey,
        currentPosition,
        remainingPath: [...detour],
    };
    return activeDetour.remainingPath;
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
    const path = findOperationalPath(beliefs, intention);

    if (path === false) {
        dbg(`${intention.type}: NO AVAILABLE PATH  me(${me.x},${me.y}) -> target(${intention.target.x},${intention.target.y})`);
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
