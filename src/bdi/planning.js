import config from "../config.js";
import { BFS, findCrateCorridor } from "../utils/geometry.js";
import {
    invalidateCratePlan,
    planCrateRoute,
    reconcileCratePlanOutcome
} from "../pddl/crate-planner.js";

const dbg = (...args) => {
    if (config.debug) console.log("[agent]", ...args);
};

/**
 * @typedef {{action:'move',dir:'up'|'down'|'left'|'right',source?:'bfs'|'pddl',intentionKey?:string,kind?:'move'|'push',from?:{x:number,y:number},to?:{x:number,y:number},crateId?:string,crateFrom?:{x:number,y:number},crateTo?:{x:number,y:number}}|{action:'pickup'}|{action:'putdown'}} Action
 */

/**
 * @typedef {{status:'action',action:Action}|{status:'wait',reason:string}|{status:'unreachable',reason:string}|{status:'deferred',reason:string}|{status:'idle'}} PlanningResult
 */

const roundPos = position => ({
    x: Math.round(position.x),
    y: Math.round(position.y)
});
const positionKey = ({ x, y }) => `${x},${y}`;
const samePosition = (a, b) => a.x === b.x && a.y === b.y;

const DEFAULT_MOVEMENT_DURATION_MS = 1000;
const BLOCKING_AGENT_WAIT_MOVES = 2;
const MAX_CONSECUTIVE_BFS_MOVE_FAILURES = 2;

/** @type {{intentionKey:string,blockedSince:number} | null} */
let activeAgentBlock = null;

/** @type {{intentionKey:string,consecutiveFailures:number} | null} */
let activeBfsMoveFailure = null;

/** @type {{routeKey:string,currentPosition:{x:number,y:number},remainingPath:{x:number,y:number}[]} | null} */
let activeDetour = null;

/**
 * @type {{intentionKey:string,finalTarget:{x:number,y:number},entry:{x:number,y:number}|null,exit:{x:number,y:number}|null,crateSignature:string,phase:'approach'|'local'|'global'} | null}
 */
let activeCrateTask = null;

/** @type {Map<string, string>} */
const suppressedIntentions = new Map();
/** @type {Map<string, number>} */
const deferredIntentions = new Map();

function intentionKey(intention) {
    return `${intention.type}:${intention.id ?? ''}:${intention.target.x},${intention.target.y}`;
}

export function isCrateTaskActiveFor(intention) {
    return Boolean(
        intention?.type
        && intention.target
        && activeCrateTask
        && activeCrateTask.intentionKey === intentionKey(intention)
    );
}

function crateSignature(beliefs) {
    return [...beliefs.crates.known.values()]
        .map(crate => `${encodeURIComponent(crate.id)}:${crate.x},${crate.y}`)
        .sort()
        .join(";");
}

/** Filters structural no-plans and temporary technical deferrals. */
export function filterPlannableDesires(desires, beliefs) {
    const currentKeys = new Set(desires.map(intentionKey));
    for (const memory of [suppressedIntentions, deferredIntentions]) {
        for (const key of memory.keys()) {
            if (!currentKeys.has(key)) memory.delete(key);
        }
    }

    const now = Date.now();
    const currentCrateSignature = crateSignature(beliefs);
    return desires.filter(desire => {
        const key = intentionKey(desire);
        const suppressed = suppressedIntentions.get(key);
        if (suppressed != null) {
            if (suppressed === currentCrateSignature) return false;
            suppressedIntentions.delete(key);
        }

        const deferredUntil = deferredIntentions.get(key);
        if ((deferredUntil ?? 0) > now) return false;
        deferredIntentions.delete(key);
        return true;
    });
}

function suppressIntention(beliefs, key) {
    deferredIntentions.delete(key);
    suppressedIntentions.set(key, crateSignature(beliefs));
    console.warn("[pddl] target suppressed until crate state changes");
}

function deferIntention(key, durationMs) {
    deferredIntentions.set(key, Date.now() + durationMs);
}

function resetAgentBlock() {
    activeAgentBlock = null;
}

function resetBfsMoveFailure() {
    activeBfsMoveFailure = null;
}

function agentBlockDurationMs(beliefs) {
    const configuredDuration = beliefs.world.movementDuration;
    const movementDuration = Number.isFinite(configuredDuration)
        && configuredDuration > 0
        ? configuredDuration
        : DEFAULT_MOVEMENT_DURATION_MS;
    return movementDuration * BLOCKING_AGENT_WAIT_MOVES;
}

function discardCrateTask(reason) {
    activeCrateTask = null;
    invalidateCratePlan(reason);
}

function resetNavigationState(reason) {
    activeDetour = null;
    resetAgentBlock();
    resetBfsMoveFailure();
    discardCrateTask(reason);
}

function handleAgentBlock(beliefs, key) {
    const now = Date.now();
    if (activeAgentBlock?.intentionKey !== key) {
        activeAgentBlock = {
            intentionKey: key,
            blockedSince: now
        };
        return { status: "wait", reason: "ordinary route temporarily blocked" };
    }

    const durationMs = agentBlockDurationMs(beliefs);
    if (now - activeAgentBlock.blockedSince < durationMs) {
        return { status: "wait", reason: "ordinary route temporarily blocked" };
    }

    deferIntention(key, durationMs);
    console.warn(
        `[agent] target deferred for ${durationMs} ms: persistent agent blocking`
    );
    resetNavigationState("persistent agent blocking");
    return { status: "deferred", reason: "persistent agent blocking" };
}

function stepDir(from, to) {
    if (to.x > from.x) return "right";
    if (to.x < from.x) return "left";
    if (to.y > from.y) return "up";
    if (to.y < from.y) return "down";
    return null;
}

function findOrdinaryPath(beliefs, target, routeKey) {
    const currentPosition = roundPos(beliefs.me.pos);
    const occupiedCratePositions = new Set();
    for (const crate of beliefs.crates.known.values()) {
        occupiedCratePositions.add(positionKey(crate));
    }
    const isCrateBlocked = position =>
        occupiedCratePositions.has(positionKey(position));
    const isBlockedForDetour = position => {
        const isAdjacent = Math.abs(position.x - currentPosition.x)
            + Math.abs(position.y - currentPosition.y) === 1;
        return isCrateBlocked(position)
            || (isAdjacent && beliefs.agents.isOccupied(position));
    };

    const ordinaryPath = BFS(beliefs, target, {
        isBlocked: isCrateBlocked,
    });
    if (ordinaryPath === false) {
        if (activeDetour?.routeKey === routeKey) activeDetour = null;
        return { exists: false, path: false };
    }
    if (ordinaryPath.length === 0) {
        activeDetour = null;
        return { exists: true, path: [] };
    }

    if (activeDetour?.routeKey !== routeKey) activeDetour = null;
    if (activeDetour) {
        if (!samePosition(currentPosition, activeDetour.currentPosition)) {
            const expectedPosition = activeDetour.remainingPath[0];
            if (expectedPosition
                && samePosition(currentPosition, expectedPosition)) {
                activeDetour.remainingPath.shift();
                activeDetour.currentPosition = currentPosition;
            } else {
                activeDetour = null;
            }
        }
    }

    if (activeDetour) {
        if (activeDetour.remainingPath.length === 0) {
            activeDetour = null;
            return { exists: true, path: [] };
        }
        const nextPosition = activeDetour.remainingPath[0];
        const blockedByCrate = isCrateBlocked(nextPosition);
        const blockedByAgent = beliefs.agents.isOccupied(nextPosition);
        if (blockedByCrate || blockedByAgent) {
            const replannedDetour = BFS(beliefs, target, {
                isBlocked: isBlockedForDetour,
            });
            if (replannedDetour === false) {
                return {
                    exists: true,
                    path: false,
                    blockedByAgent: true
                };
            }
            activeDetour.currentPosition = currentPosition;
            activeDetour.remainingPath = replannedDetour;
        }
        return { exists: true, path: activeDetour.remainingPath };
    }

    if (!beliefs.agents.isOccupied(ordinaryPath[0])) {
        return { exists: true, path: ordinaryPath };
    }

    const detour = BFS(beliefs, target, {
        isBlocked: isBlockedForDetour,
    });
    if (detour === false) {
        return { exists: true, path: false, blockedByAgent: true };
    }

    activeDetour = {
        routeKey,
        currentPosition,
        remainingPath: detour,
    };
    return { exists: true, path: activeDetour.remainingPath };
}

function resultForPath(path, terminal, intention, beliefs) {
    const me = roundPos(beliefs.me.pos);
    if (path === false) {
        return { status: "wait", reason: "ordinary route temporarily blocked" };
    }
    if (path.length === 0) {
        dbg(
            `${intention.type}: reached (${me.x},${me.y})`
            + (terminal ? `, next ${terminal.action}` : "")
        );
        return terminal
            ? { status: "action", action: terminal }
            : { status: "idle" };
    }

    const dir = stepDir(me, path[0]);
    if (dir == null) return { status: "wait", reason: "invalid next path step" };
    dbg(
        `${intention.type}: move ${dir} to (${path[0].x},${path[0].y}), `
        + `target (${intention.target.x},${intention.target.y}), remaining ${path.length}`
    );
    return {
        status: "action",
        action: {
            action: "move",
            dir,
            source: "bfs",
            intentionKey: intentionKey(intention)
        }
    };
}

function createCrateTask(beliefs, intention, key) {
    resetAgentBlock();
    resetBfsMoveFailure();
    const finalTarget = { x: intention.target.x, y: intention.target.y };
    const corridor = findCrateCorridor(beliefs, finalTarget);
    activeCrateTask = {
        intentionKey: key,
        finalTarget,
        entry: corridor ? corridor.entry : null,
        exit: corridor ? corridor.exit : null,
        crateSignature: crateSignature(beliefs),
        phase: corridor ? "approach" : "global",
    };
    if (!corridor) return;

    console.log(
        `[pddl] local route selected: entry (${corridor.entry.x},${corridor.entry.y}), `
        + `exit (${corridor.exit.x},${corridor.exit.y})`
    );
}

function ensureCrateTask(beliefs, intention, key) {
    const taskChanged = activeCrateTask
        && activeCrateTask.intentionKey !== key;
    const approachCratesChanged = activeCrateTask?.phase === "approach"
        && activeCrateTask.crateSignature !== crateSignature(beliefs);

    if (taskChanged || approachCratesChanged) {
        resetNavigationState(
            taskChanged ? "intention changed" : "crate state changed during approach"
        );
    }
    if (!activeCrateTask) createCrateTask(beliefs, intention, key);
}

async function planCratePhase(beliefs) {
    const task = activeCrateTask;
    const mode = task.phase;
    activeDetour = null;
    resetAgentBlock();
    resetBfsMoveFailure();
    const planningGoal = mode === "local" ? task.exit : task.finalTarget;
    const result = await planCrateRoute(beliefs, {
        intentionKey: task.intentionKey,
        finalTarget: task.finalTarget,
        planningGoal,
        mode,
    });

    if (result.status === "action" || result.status === "wait") return result;
    if (result.status === "deferred") {
        deferIntention(task.intentionKey, result.retryAfterMs);
        resetNavigationState(result.reason);
        return { status: "deferred", reason: result.reason };
    }
    if (result.status === "invalidated") {
        activeCrateTask = null;
        activeDetour = null;
        resetAgentBlock();
        resetBfsMoveFailure();
        return { status: "wait", reason: result.reason };
    }
    if (result.status === "completed") {
        resetNavigationState("crate plan completed");
        return mode === "local"
            ? { status: "wait", reason: "local route completed" }
            : { status: "idle" };
    }

    if (result.status !== "no-plan") {
        resetNavigationState("unexpected crate planner result");
        return { status: "wait", reason: "unexpected crate planner result" };
    }
    if (task.phase === "local") {
        task.phase = "global";
        console.log("[pddl] local plan unavailable: using global planning");
        return { status: "wait", reason: "switching to global fallback" };
    }

    suppressIntention(beliefs, task.intentionKey);
    resetNavigationState("global plan unavailable");
    return { status: "unreachable", reason: "global PDDL returned no plan" };
}

async function navigateThen(terminal, intention, beliefs) {
    const key = intentionKey(intention);
    if (activeAgentBlock
        && activeAgentBlock.intentionKey !== key) resetAgentBlock();
    if (activeBfsMoveFailure
        && activeBfsMoveFailure.intentionKey !== key) resetBfsMoveFailure();

    const ordinary = findOrdinaryPath(beliefs, intention.target, key);

    if (ordinary.exists) {
        if (activeCrateTask) {
            resetAgentBlock();
            console.log("[pddl] ordinary route available: using BFS");
        }
        discardCrateTask("ordinary path available");
        if (ordinary.blockedByAgent === true) {
            return handleAgentBlock(beliefs, key);
        }
        resetAgentBlock();
        return resultForPath(ordinary.path, terminal, intention, beliefs);
    }

    if (beliefs.crates.known.size === 0) {
        resetNavigationState("target unreachable without crates");
        return {
            status: "unreachable",
            reason: "ordinary BFS found no route and no crate can change the map",
        };
    }

    ensureCrateTask(beliefs, intention, key);

    if (activeCrateTask.phase === "approach") {
        const approach = findOrdinaryPath(
            beliefs,
            activeCrateTask.entry,
            `${key}:approach:${positionKey(activeCrateTask.entry)}`
        );
        if (!approach.exists) {
            resetAgentBlock();
            activeCrateTask.phase = "global";
            console.log("[pddl] local entry unreachable: using global planning");
        } else if (approach.blockedByAgent === true) {
            return handleAgentBlock(beliefs, key);
        } else if (approach.path === false) {
            resetAgentBlock();
            return { status: "wait", reason: "local entry temporarily blocked" };
        } else if (approach.path.length > 0) {
            resetAgentBlock();
            return resultForPath(approach.path, null, intention, beliefs);
        } else {
            resetAgentBlock();
            activeCrateTask.phase = "local";
        }
    }

    return planCratePhase(beliefs);
}

const planners = {
    go_pick_up: (intention, beliefs) =>
        navigateThen({ action: "pickup" }, intention, beliefs),
    go_deliver: (intention, beliefs) =>
        navigateThen({ action: "putdown" }, intention, beliefs),
    go_to_spawner: (intention, beliefs) =>
        navigateThen(null, intention, beliefs),
};

/**
 * @param {import("./desires.js").Desire | null} intention
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {Promise<PlanningResult>}
 */
export async function planNextAction(intention, beliefs) {
    if (!intention) {
        resetNavigationState("no active intention");
        return { status: "idle" };
    }

    const planner = planners[intention.type];
    if (!planner) {
        console.warn(`[agent] unsupported intention: ${intention.type}`);
        resetNavigationState("unknown intention type");
        return { status: "unreachable", reason: "unknown intention type" };
    }
    return planner(intention, beliefs);
}

function reconcileBfsMoveOutcome(outcome, beliefs) {
    const action = outcome?.action;
    const isBfsMove = action?.action === "move"
        && action?.source === "bfs";

    if (outcome?.status === "succeeded" && isBfsMove) {
        resetBfsMoveFailure();
        return null;
    }

    const isRejectedBfsMove = outcome?.status === "failed"
        && isBfsMove
        && typeof action.intentionKey === "string"
        && outcome.result === false
        && outcome.error == null;
    if (!isRejectedBfsMove) return null;

    if (activeBfsMoveFailure?.intentionKey !== action.intentionKey) {
        activeBfsMoveFailure = {
            intentionKey: action.intentionKey,
            consecutiveFailures: 1
        };
        return null;
    }

    activeBfsMoveFailure.consecutiveFailures += 1;
    if (activeBfsMoveFailure.consecutiveFailures
        < MAX_CONSECUTIVE_BFS_MOVE_FAILURES) return null;

    const durationMs = agentBlockDurationMs(beliefs);
    deferIntention(action.intentionKey, durationMs);
    console.warn(
        `[agent] target deferred for ${durationMs} ms: `
        + "repeated BFS move failures"
    );
    resetNavigationState("repeated BFS move failures");
    return {
        status: "deferred",
        reason: "repeated BFS move failures"
    };
}

export function reconcilePlanningOutcome(outcome, beliefs) {
    const crateResult = reconcileCratePlanOutcome(outcome);
    if (crateResult.status === "invalidated") {
        activeCrateTask = null;
        activeDetour = null;
        resetAgentBlock();
        resetBfsMoveFailure();
    }

    const bfsResult = reconcileBfsMoveOutcome(outcome, beliefs);
    return bfsResult ?? crateResult;
}
