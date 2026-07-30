import config from "../config.js";
import { readFile } from "node:fs/promises";
import { onlineSolver } from "@unitn-asa/pddl-client";
import {
    isMoveAllowed,
    isPositionTraversable,
    isPushGeometryAllowed,
    isPushTransitionAllowed
} from "../utils/geometry.js";

const DOMAIN_NAME = "deliveroo-crates";
const DEFAULT_MOVEMENT_DURATION_MS = 1000;
const BLOCKING_AGENT_WAIT_MOVES = 2;

const domainTextPromise = readFile(
    new URL("./crates-domain.pddl", import.meta.url),
    "utf8"
).catch(() => {
    console.warn("[pddl] domain file unavailable");
    return null;
});

/**
 * @typedef {Object} PddlMoveAction
 * @property {'move'} action
 * @property {'left'|'right'|'up'|'down'} dir
 * @property {'pddl'} source
 * @property {'move'|'push'} kind
 * @property {{x: number, y: number}} from
 * @property {{x: number, y: number}} to
 * @property {string} [crateId]
 * @property {{x: number, y: number}} [crateFrom]
 * @property {{x: number, y: number}} [crateTo]
 */

/**
 * @typedef {Object} ActiveCratePlan
 * @property {string} intentionKey
 * @property {{x: number, y: number}} finalTarget
 * @property {{x: number, y: number}} planningGoal
 * @property {'local'|'global'} mode
 * @property {PddlMoveAction[]} actions
 * @property {number} nextIndex
 * @property {PddlMoveAction | null} pendingAction
 * @property {number | null} blockedSince
 */

const directions = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 }
];

const positionKey = ({ x, y }) => `${x},${y}`;
const samePosition = (a, b) => a.x === b.x && a.y === b.y;
const validPosition = position =>
    Number.isInteger(position?.x) && Number.isInteger(position?.y);
const roundPosition = position => ({
    x: Math.round(position.x),
    y: Math.round(position.y)
});

function coordinateName(value) {
    return value < 0 ? `n${Math.abs(value)}` : String(value);
}

function tileName(position) {
    return `t_${coordinateName(position.x)}_${coordinateName(position.y)}`;
}

function crateName(id) {
    const normalized = id
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return `c_${normalized || "crate"}`;
}

function directionBetween(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 1 && dy === 0) return "right";
    if (dx === -1 && dy === 0) return "left";
    if (dx === 0 && dy === 1) return "up";
    if (dx === 0 && dy === -1) return "down";
    return null;
}

function isAlignedPush(behind, from, to) {
    const firstDx = from.x - behind.x;
    const firstDy = from.y - behind.y;
    const secondDx = to.x - from.x;
    const secondDy = to.y - from.y;
    return Math.abs(firstDx) + Math.abs(firstDy) === 1
        && firstDx === secondDx
        && firstDy === secondDy;
}

function buildProblemKey(
    beliefs,
    { intentionKey, finalTarget, planningGoal, mode }
) {
    const currentPosition = roundPosition(beliefs.me.pos);
    const crateState = [...beliefs.crates.known.values()]
        .map(crate => `${encodeURIComponent(crate.id)}:${crate.x},${crate.y}`)
        .sort()
        .join(";");

    return [
        `intention=${encodeURIComponent(intentionKey)}`,
        `mode=${mode}`,
        `agent=${currentPosition.x},${currentPosition.y}`,
        `goal=${planningGoal.x},${planningGoal.y}`,
        `target=${finalTarget.x},${finalTarget.y}`,
        `crates=${crateState}`
    ].join("|");
}

function buildProblem(beliefs, planningGoal) {
    if (!validPosition(beliefs?.me?.pos) || !validPosition(planningGoal)) {
        return { error: "invalid agent position or target" };
    }

    const currentPosition = roundPosition(beliefs.me.pos);
    const tiles = [...beliefs.world.tiles.values()]
        .filter(tile => validPosition(tile)
            && isPositionTraversable(beliefs, tile))
        .map(tile => ({ x: tile.x, y: tile.y }))
        .sort((a, b) => a.x - b.x || a.y - b.y);

    const tileNameByPosition = new Map();
    const tileByName = new Map();
    for (const tile of tiles) {
        const name = tileName(tile);
        tileNameByPosition.set(positionKey(tile), name);
        tileByName.set(name, tile);
    }

    const currentTileName = tileNameByPosition.get(positionKey(currentPosition));
    const targetTileName = tileNameByPosition.get(positionKey(planningGoal));
    if (!currentTileName || !targetTileName) {
        return { error: "agent position or target is not traversable" };
    }

    const crates = [...beliefs.crates.known.values()];
    if (crates.length === 0) {
        return { error: "no known crates" };
    }
    if (crates.some(crate =>
        typeof crate.id !== "string" || !validPosition(crate))) {
        return { error: "invalid known crate" };
    }
    if (crates.some(crate =>
        !tileNameByPosition.has(positionKey(crate)))) {
        return { error: "known crate is outside the traversable map" };
    }
    crates.sort((a, b) => a.id.localeCompare(b.id));

    const crateIdByName = new Map();
    const crateNameById = new Map();
    for (const crate of crates) {
        const name = crateName(crate.id);
        const existingId = crateIdByName.get(name);
        if (existingId !== undefined && existingId !== crate.id) {
            return { error: "crate name collision" };
        }

        crateIdByName.set(name, crate.id);
        crateNameById.set(crate.id, name);
    }

    const crateByPosition = new Map();
    const cratePositionById = new Map();
    for (const crate of crates) {
        const key = positionKey(crate);
        if (crateByPosition.has(key)) {
            return { error: "multiple crates on one tile" };
        }
        crateByPosition.set(key, crate);
        cratePositionById.set(crate.id, { x: crate.x, y: crate.y });
    }

    const init = [`(at-agent ${currentTileName})`];
    for (const crate of crates) {
        const crateTileName = tileNameByPosition.get(positionKey(crate));
        init.push(`(crate-at ${crateNameById.get(crate.id)} ${crateTileName})`);
    }

    for (const tile of tiles) {
        const name = tileNameByPosition.get(positionKey(tile));
        if (!crateByPosition.has(positionKey(tile))) {
            init.push(`(crate-free ${name})`);
        }
        if (beliefs.world.isCrateSpace(tile)) {
            init.push(`(crate-space ${name})`);
        }
    }

    for (const from of tiles) {
        const fromName = tileNameByPosition.get(positionKey(from));
        for (const { dx, dy } of directions) {
            const to = { x: from.x + dx, y: from.y + dy };
            const toName = tileNameByPosition.get(positionKey(to));
            if (toName && isMoveAllowed(beliefs, from, to)) {
                init.push(`(adjacent ${fromName} ${toName})`);
            }
        }
    }

    for (const from of tiles) {
        if (!beliefs.world.isCrateSpace(from)) continue;
        const fromName = tileNameByPosition.get(positionKey(from));

        for (const { dx, dy } of directions) {
            const behind = { x: from.x - dx, y: from.y - dy };
            const to = { x: from.x + dx, y: from.y + dy };
            const behindName = tileNameByPosition.get(positionKey(behind));
            const toName = tileNameByPosition.get(positionKey(to));

            if (
                behindName
                && toName
                && isPushGeometryAllowed(beliefs, behind, from, to)
            ) {
                init.push(`(push-line ${behindName} ${fromName} ${toName})`);
            }
        }
    }

    const tileObjects = [...tileByName.keys()].join(" ");
    const crateObjects = [...crateIdByName.keys()].join(" ");
    const problem = [
        "(define (problem crate-fallback)",
        `    (:domain ${DOMAIN_NAME})`,
        "    (:objects",
        `        ${tileObjects} - tile`,
        `        ${crateObjects} - crate`,
        "    )",
        "    (:init",
        ...init.map(fact => `        ${fact}`),
        "    )",
        `    (:goal (at-agent ${targetTileName}))`,
        ")"
    ].join("\n");

    return {
        problem,
        currentPosition,
        tileByName,
        crateIdByName,
        cratePositionById
    };
}

function normalizePlan(plan, snapshot, target) {
    if (!Array.isArray(plan)) {
        return { error: "solver result is not an array" };
    }
    if (plan.length === 0) {
        return samePosition(snapshot.currentPosition, target)
            ? { actions: [] }
            : { error: "empty plan before target" };
    }

    const actions = [];
    let expectedAgentPosition = snapshot.currentPosition;
    const cratePositionById = new Map(snapshot.cratePositionById);
    const crateIdByPosition = new Map(
        [...cratePositionById].map(([id, position]) =>
            [positionKey(position), id])
    );

    for (const step of plan) {
        if (
            !step
            || typeof step !== "object"
            || typeof step.action !== "string"
            || !Array.isArray(step.args)
            || step.args.some(argument => typeof argument !== "string" || argument.length === 0)
        ) {
            return { error: "malformed plan step" };
        }

        const actionName = step.action.toLowerCase();
        const args = step.args.map(argument => argument.toLowerCase());

        if (actionName === "move") {
            if (args.length !== 2) return { error: "malformed move step" };
            const [fromName, toName] = args;
            const from = snapshot.tileByName.get(fromName);
            const to = snapshot.tileByName.get(toName);
            const dir = from && to ? directionBetween(from, to) : null;
            if (
                !from
                || !to
                || !dir
                || !samePosition(expectedAgentPosition, from)
                || crateIdByPosition.has(positionKey(to))
            ) {
                return { error: "invalid move transition" };
            }

            actions.push({
                action: "move",
                dir,
                source: "pddl",
                kind: "move",
                from: { ...from },
                to: { ...to }
            });
            expectedAgentPosition = to;
            continue;
        }

        if (actionName === "push") {
            if (args.length !== 4) return { error: "malformed push step" };
            const [crateNameValue, behindName, fromName, toName] = args;
            const crateId = snapshot.crateIdByName.get(crateNameValue);
            const behind = snapshot.tileByName.get(behindName);
            const from = snapshot.tileByName.get(fromName);
            const to = snapshot.tileByName.get(toName);
            const currentCratePosition = cratePositionById.get(crateId);
            const dir = behind && from ? directionBetween(behind, from) : null;

            if (
                crateId === undefined
                || !behind
                || !from
                || !to
                || !dir
                || !isAlignedPush(behind, from, to)
                || !samePosition(expectedAgentPosition, behind)
                || !currentCratePosition
                || !samePosition(currentCratePosition, from)
                || crateIdByPosition.has(positionKey(to))
            ) {
                return { error: "invalid push transition" };
            }

            actions.push({
                action: "move",
                dir,
                source: "pddl",
                kind: "push",
                from: { ...behind },
                to: { ...from },
                crateId,
                crateFrom: { ...from },
                crateTo: { ...to }
            });
            crateIdByPosition.delete(positionKey(from));
            crateIdByPosition.set(positionKey(to), crateId);
            cratePositionById.set(crateId, { ...to });
            expectedAgentPosition = from;
            continue;
        }

        return { error: "unknown plan action" };
    }

    if (!samePosition(expectedAgentPosition, target)) {
        return { error: "plan does not reach target" };
    }

    return { actions };
}

function validateNextAction(action, beliefs) {
    const currentPosition = roundPosition(beliefs.me.pos);
    if (!samePosition(currentPosition, action.from)) return "invalid";

    if (action.kind === "move") {
        if (
            !isMoveAllowed(beliefs, action.from, action.to)
            || beliefs.crates.isOccupied(action.to)
        ) {
            return "invalid";
        }
        if (beliefs.agents.isOccupied(action.to)) return "agent-blocked";
        return "valid";
    }

    if (action.kind !== "push") return "invalid";

    const crate = beliefs.crates.getAt(action.crateFrom);
    const expectedDirection = directionBetween(action.from, action.to);
    if (
        !crate
        || !samePosition(action.to, action.crateFrom)
        || crate.id !== action.crateId
        || !isPushTransitionAllowed(
            beliefs,
            action.from,
            action.crateFrom,
            action.crateTo
        )
        || action.dir !== expectedDirection
    ) {
        return "invalid";
    }

    if (beliefs.agents.isOccupied(action.crateTo)) return "agent-blocked";
    return "valid";
}

function deferredResult(reason) {
    console.warn(
        `[pddl] target deferred for ${config.pddl.retryMs} ms: ${reason}`
    );
    return {
        status: "deferred",
        reason,
        retryAfterMs: config.pddl.retryMs,
    };
}

function blockingAgentTimeoutMs(beliefs) {
    const configuredDuration = beliefs?.world?.movementDuration;
    const movementDuration = Number.isFinite(configuredDuration)
        && configuredDuration > 0
        ? configuredDuration
        : DEFAULT_MOVEMENT_DURATION_MS;
    return movementDuration * BLOCKING_AGENT_WAIT_MOVES;
}

/**
 * Solves and runs the crate routes of one agent. The plan being executed and
 * the pending solver request belong to that agent, so each one owns an
 * instance. The domain text stays shared: it is immutable data, not state.
 */
export class CratePlanner {
    constructor() {
        /** @type {ActiveCratePlan | null} */
        this.activePlan = null;

        /** @type {Promise<{status:'resolved',plan:*}|{status:'rejected',error:*}> | null} */
        this.activeSolvePromise = null;
    }

    async solveWithTimeout(domain, problem) {
        let timeoutId;
        const solverResult = onlineSolver(domain, problem).then(
            plan => ({ status: "resolved", plan }),
            error => ({ status: "rejected", error })
        );
        this.activeSolvePromise = solverResult;
        solverResult.then(() => {
            if (this.activeSolvePromise === solverResult) {
                this.activeSolvePromise = null;
            }
        });
        const timeout = new Promise(resolve => {
            timeoutId = setTimeout(
                () => resolve({ status: "timeout" }),
                config.pddl.timeoutMs
            );
        });
        const result = await Promise.race([solverResult, timeout]);
        clearTimeout(timeoutId);
        return result;
    }

    nextActiveAction(beliefs) {
        if (this.activePlan.pendingAction) {
            return { status: "wait", reason: "action outcome pending" };
        }
        if (this.activePlan.nextIndex >= this.activePlan.actions.length) {
            this.activePlan = null;
            return { status: "completed" };
        }

        const action = this.activePlan.actions[this.activePlan.nextIndex];
        const validation = validateNextAction(action, beliefs);
        if (validation === "agent-blocked") {
            const now = Date.now();
            if (this.activePlan.blockedSince == null) {
                this.activePlan.blockedSince = now;
                console.log("[pddl] waiting for blocking agent");
            }
            if (now - this.activePlan.blockedSince < blockingAgentTimeoutMs(beliefs)) {
                return { status: "wait", reason: "blocking agent" };
            }

            console.warn("[pddl] blocking agent wait expired");
            this.invalidateCratePlan("blocking agent timeout");
            return deferredResult("blocking agent timeout");
        }
        this.activePlan.blockedSince = null;
        if (validation !== "valid") {
            this.invalidateCratePlan("next action is no longer applicable");
            return {
                status: "invalidated",
                reason: "next action is no longer applicable",
            };
        }

        this.activePlan.pendingAction = action;
        if (action.kind === "push") {
            console.log(`[pddl] push ready: crate ${action.crateId}`);
        }
        return { status: "action", action };
    }

    /**
     * Returns one explicit result for a local or global crate route.
     * @param {import("../bdi/beliefs.js").Beliefs} beliefs
     * @param {{intentionKey:string,finalTarget:{x:number,y:number},planningGoal:{x:number,y:number},mode:'local'|'global'}} request
     * @returns {Promise<{status:'action',action:PddlMoveAction}|{status:'completed'}|{status:'wait',reason:string}|{status:'no-plan'}|{status:'deferred',reason:string,retryAfterMs:number}|{status:'invalidated',reason:string}>}
     */
    async planCrateRoute(beliefs, request) {
        const { intentionKey, finalTarget, planningGoal, mode } = request ?? {};
        if (
            !validPosition(beliefs?.me?.pos)
            || !validPosition(finalTarget)
            || !validPosition(planningGoal)
            || (mode !== "local" && mode !== "global")
            || typeof intentionKey !== "string"
            || !(beliefs?.crates?.known instanceof Map)
        ) {
            return deferredResult("invalid planning input");
        }

        const requestChanged = this.activePlan !== null
            && (
                this.activePlan.intentionKey !== intentionKey
                || this.activePlan.mode !== mode
                || !samePosition(this.activePlan.finalTarget, finalTarget)
                || !samePosition(this.activePlan.planningGoal, planningGoal)
            );
        if (requestChanged) {
            this.invalidateCratePlan("planning request changed");
        }

        if (this.activePlan) return this.nextActiveAction(beliefs);

        const problemKey = buildProblemKey(beliefs, request);
        const snapshot = buildProblem(beliefs, planningGoal);
        if (snapshot.error) return deferredResult(snapshot.error);

        const domain = await domainTextPromise;
        if (!domain) return deferredResult("domain unavailable");
        if (this.activeSolvePromise) {
            return deferredResult("solver request still pending");
        }

        const startedAt = Date.now();
        console.log(`[pddl] ${mode} planning started`);
        const solverResult = await this.solveWithTimeout(domain, snapshot.problem);

        if (solverResult.status === "timeout") {
            return deferredResult(
                `solve timed out after ${config.pddl.timeoutMs} ms`
            );
        }
        if (solverResult.status === "rejected") {
            const errorMessage = solverResult.error instanceof Error
                ? solverResult.error.message
                : String(solverResult.error ?? "unknown error");
            return deferredResult(
                `solver error: ${errorMessage}`
            );
        }

        const currentProblemKey = buildProblemKey(beliefs, request);
        if (currentProblemKey !== problemKey) {
            console.warn("[pddl] plan invalidated: state changed during solve");
            return { status: "invalidated", reason: "state changed during solve" };
        }

        if (solverResult.plan == null) {
            console.warn("[pddl] no plan found");
            return { status: "no-plan" };
        }

        const normalized = normalizePlan(solverResult.plan, snapshot, planningGoal);
        if (normalized.error) {
            const reason = `malformed plan: ${normalized.error}`;
            return deferredResult(reason);
        }

        this.activePlan = {
            intentionKey,
            finalTarget: { x: finalTarget.x, y: finalTarget.y },
            planningGoal: { x: planningGoal.x, y: planningGoal.y },
            mode,
            actions: normalized.actions,
            nextIndex: 0,
            pendingAction: null,
            blockedSince: null,
        };
        console.log(
            `[pddl] plan ready: ${normalized.actions.length} actions in `
            + `${Date.now() - startedAt} ms`
        );

        return this.nextActiveAction(beliefs);
    }

    /** Advances or invalidates the active plan after its pending action outcome. */
    reconcileCratePlanOutcome(outcome) {
        const action = outcome?.action;
        if (action?.source !== "pddl" || !this.activePlan?.pendingAction) {
            return { status: "ignored" };
        }
        if (action !== this.activePlan.pendingAction) return { status: "ignored" };

        if (outcome.status === "succeeded") {
            this.activePlan.nextIndex += 1;
            this.activePlan.pendingAction = null;
            this.activePlan.blockedSince = null;
            return { status: "advanced" };
        }
        if (outcome.status === "failed") {
            this.invalidateCratePlan("PDDL action failed");
            return { status: "invalidated", reason: "PDDL action failed" };
        }

        return { status: "ignored" };
    }

    invalidateCratePlan(reason) {
        const hadActivePlan = this.activePlan != null;
        this.activePlan = null;
        if (hadActivePlan) console.warn(`[pddl] plan invalidated: ${reason}`);
    }
}
