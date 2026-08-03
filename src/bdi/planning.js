import config from "../config.js";
import { desireKey } from "./desires.js";
import { BFS, findCrateCorridor } from "../utils/geometry.js";
import { CratePlanner } from "../pddl/crate-planner.js";
import { POSITION_KEY } from "./beliefs.js";

// Both agents plan with this same code in one process, so every line says which of the two
// wrote it. The name comes from the token and is not known until the server sends it.
const dbg = (beliefs, ...args) => {
    if (config.debug) console.log(`[${beliefs.me.name || "agent"}]`, ...args);
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

const samePosition = (a, b) => a.x === b.x && a.y === b.y;

// Two rejections in a row mean the route is really taken, not that we were
// unlucky once. Raising it makes the agent keep pushing into a blocked tile,
// lowering it makes it abandon goals after a single mishap.
const MAX_CONSECUTIVE_BFS_MOVE_FAILURES = 2;

/**
 * This function creates and returns the signature in string form
 * for the known crates in the map given an agent's beliefs.
 * @param {import("./beliefs.js").Beliefs} beliefs 
 * @returns {string} the crate signature.
 */
function crateSignature(beliefs) {
    return [...beliefs.crates.known.values()]
        .map(crate => `${encodeURIComponent(crate.id)}:${crate.x},${crate.y}`)
        .sort()
        .join(";");
}

/**
 * This function returns the direction of a step given a starting point and a destination point.
 * @param {import("./desires.js").Point} from 
 * @param {import("./desires.js").Point} to 
 * @returns {string} a string defining the direction of a step.
 */
function stepDir(from, to) {
    if (to.x > from.x) return "right";
    if (to.x < from.x) return "left";
    if (to.y > from.y) return "up";
    if (to.y < from.y) return "down";
    return null;
}

/**
 * This function returns the result for a given path, given the terminal action,
 * the current intention and the agent's beliefs.
 * @param {false | Point []} path 
 * @param {{action: string} | null} terminal 
 * @param {import("./desires.js").Desire} intention 
 * @param {import("./beliefs.js").Beliefs} beliefs 
 * @returns {{status: string, action: string | {action: string, dir: string, source: string, intentionKey: string} | null}} the result for the given path.
 */
function resultForPath(path, terminal, intention, beliefs) {
    const me = roundPos(beliefs.me.pos);
    if (path === false) {
        return { status: "wait", reason: "ordinary route temporarily blocked" };
    }
    if (path.length === 0) {
        // A hold plans the same arrival every cycle for as long as it lasts, and saying so each
        // time buries the rest of the log. Waiting is what a hold is for, and the move that got
        // the agent here was already logged.
        if (intention.type !== "go_to_tile") {
            dbg(
                beliefs,
                `${intention.type}: reached (${me.x},${me.y})`
                + (terminal ? `, next ${terminal.action}` : "")
            );
        }
        return terminal
            ? { status: "action", action: terminal }
            : { status: "idle" };
    }

    const dir = stepDir(me, path[0]);
    if (dir == null) return { status: "wait", reason: "invalid next path step" };
    dbg(
        beliefs,
        `${intention.type}: move ${dir} to (${path[0].x},${path[0].y}), `
        + `target (${intention.target.x},${intention.target.y}), remaining ${path.length}`
    );
    return {
        status: "action",
        action: {
            action: "move",
            dir,
            source: "bfs",
            intentionKey: desireKey(intention)
        }
    };
}

// Plan library, keyed by intention type. 
// The planner is passed in so the table itself holds no agent state.
// Walking to a tile and doing nothing on arrival serves two goals that differ only in where
// the tile came from: an unchecked spawner, or a mission that named one. They share the plan.
const navigateOnly = (planner, intention, beliefs) =>
    planner.navigateThen(null, intention, beliefs);

const planners = {
    go_pick_up: (planner, intention, beliefs) =>
        planner.navigateThen({ action: "pickup" }, intention, beliefs),
    go_deliver: (planner, intention, beliefs) =>
        planner.navigateThen({ action: "putdown" }, intention, beliefs),
    go_to_spawner: navigateOnly,
    go_to_tile: navigateOnly,
};

/**
 * This class represents the Plan step of the BDI cycle: turns an intention into the next action.
 * It holds the plan being executed and the memory of which goals cannot be
 * planned right now, so one instance belongs to one agent and two agents in
 * the same process cannot overwrite each other.
 */
export class Planner {
    constructor() {
        /** @type {{intentionKey:string,blockedSince:number} | null} */
        this.activeAgentBlock = null;

        /** @type {{intentionKey:string,consecutiveFailures:number} | null} */
        this.activeBfsMoveFailure = null;

        /** @type {{routeKey:string,currentPosition:{x:number,y:number},remainingPath:{x:number,y:number}[]} | null} */
        this.activeDetour = null;

        /**
         * @type {{intentionKey:string,finalTarget:{x:number,y:number},entry:{x:number,y:number}|null,exit:{x:number,y:number}|null,crateSignature:string,phase:'approach'|'local'|'global'} | null}
         */
        this.activeCrateTask = null;

        /** @type {Map<string, string>} */
        this.suppressedIntentions = new Map();
        
        /** @type {Map<string, number>} */
        this.deferredIntentions = new Map();

        /** @type {import("../pddl/crate-planner.js").CratePlanner} */
        this.cratePlanner = new CratePlanner();
    }

    /**
     * This function checks and returns whether if the given intention is a Crate Task, specifically
     * designed for edge cases in particular maps where there's "corridors" created by crates, that need
     * to be traversed by the agent.
     * @param {import("./desires.js").Desire} intention 
     * @returns {boolean} true if the active (current) given intention is a Crate Task, false otherwise.
     */
    isCrateTaskActiveFor(intention) {
        return Boolean(
            intention?.type
            && intention.target
            && this.activeCrateTask
            && this.activeCrateTask.intentionKey === desireKey(intention)
        );
    }

    /** Filters structural no-plans and temporary technical deferrals. */
    /**
     * This function filters the given plannable desires, given the agent's beliefs.
     * In particular, it filters out outdated desires, suppressed desires
     *  or deferred desires whose deferral time has passed.
     * @param {import("./desires.js").Desire[]} desires 
     * @param {import("./beliefs.js").Beliefs} beliefs 
     * @returns {import("./desires.js").Desire[]} A filtered array of desires.
     */
    filterPlannableDesires(desires, beliefs) {
        const currentKeys = new Set(desires.map(desireKey));
        for (const memory of [this.suppressedIntentions, this.deferredIntentions]) {
            for (const key of memory.keys()) {
                if (!currentKeys.has(key)) memory.delete(key);
            }
        }

        const now = Date.now();
        const currentCrateSignature = crateSignature(beliefs);
        return desires.filter(desire => {
            const key = desireKey(desire);
            const suppressed = this.suppressedIntentions.get(key);
            if (suppressed != null) {
                if (suppressed === currentCrateSignature) return false;
                this.suppressedIntentions.delete(key);
            }

            const deferredUntil = this.deferredIntentions.get(key);
            if ((deferredUntil ?? 0) > now) return false;
            this.deferredIntentions.delete(key);
            return true;
        });
    }

    /**
     * This function suppresses an intention with the given key.
     * @param {import("./beliefs.js").Beliefs} beliefs 
     * @param {string} key 
     */
    suppressIntention(beliefs, key) {
        this.deferredIntentions.delete(key);
        this.suppressedIntentions.set(key, crateSignature(beliefs));
        console.warn("[pddl] target suppressed until crate state changes");
    }

    /**
     * This function defers the intention with the given key for the given amount of milliseconds.
     * @param {string} key 
     * @param {number} durationMs 
     */
    deferIntention(key, durationMs) {
        this.deferredIntentions.set(key, Date.now() + durationMs);
    }

    resetAgentBlock() {
        this.activeAgentBlock = null;
    }

    resetBfsMoveFailure() {
        this.activeBfsMoveFailure = null;
    }

    /**
     * @param {string} reason 
     */
    discardCrateTask(reason) {
        this.activeCrateTask = null;
        this.cratePlanner.invalidateCratePlan(reason);
    }

    /**
     * @param {string} reason 
     */
    resetPlanningState(reason) {
        this.activeDetour = null;
        this.resetAgentBlock();
        this.resetBfsMoveFailure();
        this.discardCrateTask(reason);
    }

    /**
     * This function applies the operations needed to block the agent when needed
     * and returns an object with information about the block.
     * @param {import("./beliefs.js").Beliefs} beliefs 
     * @param {string} key 
     * @returns {{status: string, reason: string}} an object containing the status of the current plan and the reason for the block.
     */
    handleAgentBlock(beliefs, key) {
        const now = Date.now();
        if (this.activeAgentBlock?.intentionKey !== key) {
            this.activeAgentBlock = {
                intentionKey: key,
                blockedSince: now
            };
            return { status: "wait", reason: "ordinary route temporarily blocked" };
        }

        const durationMs = beliefs.world.blockingAgentWaitMs();
        if (now - this.activeAgentBlock.blockedSince < durationMs) {
            return { status: "wait", reason: "ordinary route temporarily blocked" };
        }

        this.deferIntention(key, durationMs);
        console.warn(
            `[${beliefs.me.name || "agent"}] target deferred for ${durationMs} ms: `
            + "persistent agent blocking"
        );
        this.resetPlanningState("persistent agent blocking");
        return { status: "deferred", reason: "persistent agent blocking" };
    }

    /**
     * This function finds an ordinary path through BFS given the agent's beliefs and it's Point target
     * and it returns an object with the path's information.
     * @param {import("./beliefs.js").Beliefs} beliefs 
     * @param {import("./desires.js").Point} target 
     * @param {string} routeKey 
     * @returns {{exists: boolean, path: false | import("./desires.js").Point[], blockedByAgent: true | null}} an object containing the found path's information.
     */
    findOrdinaryPath(beliefs, target, routeKey) {
        const currentPosition = roundPos(beliefs.me.pos);
        const occupiedCratePositions = new Set();
        for (const crate of beliefs.crates.known.values()) {
            occupiedCratePositions.add(POSITION_KEY(crate));
        }
        const isCrateBlocked = position =>
            occupiedCratePositions.has(POSITION_KEY(position));
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
            if (this.activeDetour?.routeKey === routeKey) this.activeDetour = null;
            return { exists: false, path: false };
        }
        if (ordinaryPath.length === 0) {
            this.activeDetour = null;
            return { exists: true, path: [] };
        }

        if (this.activeDetour?.routeKey !== routeKey) this.activeDetour = null;
        if (this.activeDetour) {
            if (!samePosition(currentPosition, this.activeDetour.currentPosition)) {
                const expectedPosition = this.activeDetour.remainingPath[0];
                if (expectedPosition
                    && samePosition(currentPosition, expectedPosition)) {
                    this.activeDetour.remainingPath.shift();
                    this.activeDetour.currentPosition = currentPosition;
                } else {
                    this.activeDetour = null;
                }
            }
        }

        if (this.activeDetour) {
            if (this.activeDetour.remainingPath.length === 0) {
                this.activeDetour = null;
                return { exists: true, path: [] };
            }
            const nextPosition = this.activeDetour.remainingPath[0];
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
                this.activeDetour.currentPosition = currentPosition;
                this.activeDetour.remainingPath = replannedDetour;
            }
            return { exists: true, path: this.activeDetour.remainingPath };
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

        this.activeDetour = {
            routeKey,
            currentPosition,
            remainingPath: detour,
        };
        return { exists: true, path: this.activeDetour.remainingPath };
    }

    /**
     * This function handles the creation of a Crate Task, used in maps with crates that create corridors.
     * @param {import("./beliefs.js").Beliefs} beliefs 
     * @param {import("./desires.js").Desire} intention 
     * @param {string} key 
     */
    createCrateTask(beliefs, intention, key) {
        this.resetAgentBlock();
        this.resetBfsMoveFailure();
        const finalTarget = { x: intention.target.x, y: intention.target.y };
        const corridor = findCrateCorridor(beliefs, finalTarget);
        this.activeCrateTask = {
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

    /**
     * This function is used to recheck the current Crate Task.
     * @param {import("./beliefs.js").Beliefs} beliefs 
     * @param {import("./desires.js").Desire} intention 
     * @param {string} key 
     */
    ensureCrateTask(beliefs, intention, key) {
        const taskChanged = this.activeCrateTask
            && this.activeCrateTask.intentionKey !== key;
        const approachCratesChanged = this.activeCrateTask?.phase === "approach"
            && this.activeCrateTask.crateSignature !== crateSignature(beliefs);

        if (taskChanged || approachCratesChanged) {
            this.resetPlanningState(
                taskChanged ? "intention changed" : "crate state changed during approach"
            );
        }
        if (!this.activeCrateTask) this.createCrateTask(beliefs, intention, key);
    }

    /**
     * This function plans the Crate Task and its phases.
     * It returns an object containing information about the result of the Crate Task.
     * @param {import("./beliefs.js").Beliefs} beliefs 
     * @returns {{status: string, reason string}} an object with the information about the outcome of the Crate Task.
     */
    async planCratePhase(beliefs) {
        const task = this.activeCrateTask;
        const mode = task.phase;
        this.activeDetour = null;
        this.resetAgentBlock();
        this.resetBfsMoveFailure();
        const planningGoal = mode === "local" ? task.exit : task.finalTarget;
        const result = await this.cratePlanner.planCrateRoute(beliefs, {
            intentionKey: task.intentionKey,
            finalTarget: task.finalTarget,
            planningGoal,
            mode,
        });

        if (result.status === "action" || result.status === "wait") return result;
        if (result.status === "deferred") {
            this.deferIntention(task.intentionKey, result.retryAfterMs);
            this.resetPlanningState(result.reason);
            return { status: "deferred", reason: result.reason };
        }
        if (result.status === "invalidated") {
            this.activeCrateTask = null;
            this.activeDetour = null;
            this.resetAgentBlock();
            this.resetBfsMoveFailure();
            return { status: "wait", reason: result.reason };
        }
        if (result.status === "completed") {
            this.resetPlanningState("crate plan completed");
            return mode === "local"
                ? { status: "wait", reason: "local route completed" }
                : { status: "idle" };
        }

        if (result.status !== "no-plan") {
            this.resetPlanningState("unexpected crate planner result");
            return { status: "wait", reason: "unexpected crate planner result" };
        }
        if (task.phase === "local") {
            task.phase = "global";
            console.log("[pddl] local plan unavailable: using global planning");
            return { status: "wait", reason: "switching to global fallback" };
        }

        this.suppressIntention(beliefs, task.intentionKey);
        this.resetPlanningState("global plan unavailable");
        return { status: "unreachable", reason: "global PDDL returned no plan" };
    }

    /**
     * This function handles the navigation of the agent.
     * It handles cases where the navigation can be done directly, cases
     * where there's crates in the way and other cases.
     * @param {{action: string | null}} terminal 
     * @param {*} intention 
     * @param {*} beliefs 
     * @returns {{status: string, action: string | {action: string, dir: string, source: string, intentionKey: string} | null} | {status: string, reason: "string"}}
     */
    async navigateThen(terminal, intention, beliefs) {
        const key = desireKey(intention);
        if (this.activeAgentBlock
            && this.activeAgentBlock.intentionKey !== key) this.resetAgentBlock();
        if (this.activeBfsMoveFailure
            && this.activeBfsMoveFailure.intentionKey !== key) this.resetBfsMoveFailure();

        const ordinary = this.findOrdinaryPath(beliefs, intention.target, key);

        if (ordinary.exists) {
            if (this.activeCrateTask) {
                this.resetAgentBlock();
                console.log("[pddl] ordinary route available: using BFS");
            }
            this.discardCrateTask("ordinary path available");
            if (ordinary.blockedByAgent === true) {
                return this.handleAgentBlock(beliefs, key);
            }
            this.resetAgentBlock();
            return resultForPath(ordinary.path, terminal, intention, beliefs);
        }

        if (beliefs.crates.known.size === 0) {
            this.resetPlanningState("target unreachable without crates");
            return {
                status: "unreachable",
                reason: "ordinary BFS found no route and no crate can change the map",
            };
        }

        this.ensureCrateTask(beliefs, intention, key);

        if (this.activeCrateTask.phase === "approach") {
            const approach = this.findOrdinaryPath(
                beliefs,
                this.activeCrateTask.entry,
                `${key}:approach:${POSITION_KEY(this.activeCrateTask.entry)}`
            );
            if (!approach.exists) {
                this.resetAgentBlock();
                this.activeCrateTask.phase = "global";
                console.log("[pddl] local entry unreachable: using global planning");
            } else if (approach.blockedByAgent === true) {
                return this.handleAgentBlock(beliefs, key);
            } else if (approach.path === false) {
                this.resetAgentBlock();
                return { status: "wait", reason: "local entry temporarily blocked" };
            } else if (approach.path.length > 0) {
                this.resetAgentBlock();
                return resultForPath(approach.path, null, intention, beliefs);
            } else {
                this.resetAgentBlock();
                this.activeCrateTask.phase = "local";
            }
        }

        return this.planCratePhase(beliefs);
    }

    /**
     * This function plans the next action.
     * @param {import("./desires.js").Desire | null} intention
     * @param {import("./beliefs.js").Beliefs} beliefs
     * @returns {Promise<PlanningResult>}
     */
    async planNextAction(intention, beliefs) {
        if (!intention) {
            this.resetPlanningState("no active intention");
            return { status: "idle" };
        }

        const handler = planners[intention.type];
        if (!handler) {
            console.warn(
                `[${beliefs.me.name || "agent"}] unsupported intention: ${intention.type}`
            );
            this.resetPlanningState("unknown intention type");
            return { status: "unreachable", reason: "unknown intention type" };
        }
        return handler(this, intention, beliefs);
    }

    reconcileBfsMoveOutcome(outcome, beliefs) {
        const action = outcome?.action;
        const isBfsMove = action?.action === "move"
            && action?.source === "bfs";

        if (outcome?.status === "succeeded" && isBfsMove) {
            this.resetBfsMoveFailure();
            return null;
        }

        const isRejectedBfsMove = outcome?.status === "failed"
            && isBfsMove
            && typeof action.intentionKey === "string"
            && outcome.result === false
            && outcome.error == null;
        if (!isRejectedBfsMove) return null;

        if (this.activeBfsMoveFailure?.intentionKey !== action.intentionKey) {
            this.activeBfsMoveFailure = {
                intentionKey: action.intentionKey,
                consecutiveFailures: 1
            };
            return null;
        }

        this.activeBfsMoveFailure.consecutiveFailures += 1;
        if (this.activeBfsMoveFailure.consecutiveFailures
            < MAX_CONSECUTIVE_BFS_MOVE_FAILURES) return null;

        const durationMs = beliefs.world.blockingAgentWaitMs();
        this.deferIntention(action.intentionKey, durationMs);
        console.warn(
            `[${beliefs.me.name || "agent"}] target deferred for ${durationMs} ms: `
            + "repeated BFS move failures"
        );
        this.resetPlanningState("repeated BFS move failures");
        return {
            status: "deferred",
            reason: "repeated BFS move failures"
        };
    }

    reconcilePlanningOutcome(outcome, beliefs) {
        const crateResult = this.cratePlanner.reconcileCratePlanOutcome(outcome);
        if (crateResult.status === "invalidated") {
            this.activeCrateTask = null;
            this.activeDetour = null;
            this.resetAgentBlock();
            this.resetBfsMoveFailure();
        }

        const bfsResult = this.reconcileBfsMoveOutcome(outcome, beliefs);
        return bfsResult ?? crateResult;
    }
}
