import { readFile } from "node:fs/promises";
import { onlineSolver } from "@unitn-asa/pddl-client";
import {
    isMoveAllowed,
    isPositionTraversable
} from "../utils/geometry.js";

const DOMAIN_NAME = "deliveroo-crates";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_MS = 5000;

function positiveEnvironmentNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PDDL_TIMEOUT_MS = positiveEnvironmentNumber(
    "PDDL_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS
);
const PDDL_RETRY_MS = positiveEnvironmentNumber(
    "PDDL_RETRY_MS",
    DEFAULT_RETRY_MS
);

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
 * @property {string} problemKey
 * @property {string} intentionKey
 * @property {{x: number, y: number}} target
 * @property {PddlMoveAction[]} actions
 * @property {number} nextIndex
 * @property {PddlMoveAction | null} pendingAction
 */

/** @type {ActiveCratePlan | null} */
let activePlan = null;
let lastFailedProblemKey = null;
let lastFailedAt = 0;

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

function buildProblemKey(beliefs, intentionKey, target) {
    const currentPosition = roundPosition(beliefs.me.pos);
    const crateState = [...beliefs.crates.known.values()]
        .map(crate => `${encodeURIComponent(crate.id)}:${crate.x},${crate.y}`)
        .sort()
        .join(";");

    return [
        `intention=${encodeURIComponent(intentionKey)}`,
        `agent=${currentPosition.x},${currentPosition.y}`,
        `target=${target.x},${target.y}`,
        `crates=${crateState}`
    ].join("|");
}

function buildProblem(beliefs, target) {
    if (!validPosition(beliefs?.me?.pos) || !validPosition(target)) {
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
    const targetTileName = tileNameByPosition.get(positionKey(target));
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
        if (crateTileName) {
            init.push(`(crate-at ${crateNameById.get(crate.id)} ${crateTileName})`);
        }
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
                && beliefs.world.isCrateSpace(to)
                && isMoveAllowed(beliefs, behind, from)
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
    const cratePositionById = new Map(
        [...snapshot.cratePositionById].map(([id, position]) =>
            [id, { ...position }])
    );
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
        || !beliefs.world.isCrateSpace(action.crateFrom)
        || !beliefs.world.isCrateSpace(action.crateTo)
        || beliefs.crates.isOccupied(action.crateTo)
        || !isMoveAllowed(beliefs, action.from, action.to)
        || !isAlignedPush(action.from, action.crateFrom, action.crateTo)
        || action.dir !== expectedDirection
    ) {
        return "invalid";
    }

    if (beliefs.agents.isOccupied(action.crateTo)) return "agent-blocked";
    return "valid";
}

function recordFailure(problemKey, message) {
    lastFailedProblemKey = problemKey;
    lastFailedAt = Date.now();
    console.warn(`[pddl] ${message}; retry delayed ${PDDL_RETRY_MS} ms`);
}

async function solveWithTimeout(domain, problem) {
    let timeoutId;
    const solverResult = onlineSolver(domain, problem).then(
        plan => ({ status: "resolved", plan }),
        error => ({ status: "rejected", error })
    );
    const timeout = new Promise(resolve => {
        timeoutId = setTimeout(
            () => resolve({ status: "timeout" }),
            PDDL_TIMEOUT_MS
        );
    });
    const result = await Promise.race([solverResult, timeout]);
    clearTimeout(timeoutId);
    return result;
}

function nextActiveAction(beliefs) {
    if (!activePlan || activePlan.pendingAction) return null;
    if (activePlan.nextIndex >= activePlan.actions.length) {
        invalidateCratePlan("plan exhausted before ordinary navigation resumed");
        return null;
    }

    const action = activePlan.actions[activePlan.nextIndex];
    const validation = validateNextAction(action, beliefs);
    if (validation === "agent-blocked") return null;
    if (validation !== "valid") {
        invalidateCratePlan("next action is no longer applicable");
        return null;
    }

    activePlan.pendingAction = action;
    activePlan.problemKey = buildProblemKey(
        beliefs,
        activePlan.intentionKey,
        activePlan.target
    );
    if (action.kind === "push") {
        console.log(`[pddl] push ${action.crateId} returned to agent cycle`);
    }
    return action;
}

/**
 * Returns one validated PDDL action for a crate-blocked target, or null.
 * @returns {Promise<PddlMoveAction | null>}
 */
export async function planCrateFallback(beliefs, intentionKey, target) {
    if (
        !validPosition(beliefs?.me?.pos)
        || !validPosition(target)
        || !(beliefs?.crates?.known instanceof Map)
    ) {
        console.warn("[pddl] invalid planning input");
        return null;
    }

    if (
        activePlan
        && (
            activePlan.intentionKey !== intentionKey
            || !samePosition(activePlan.target, target)
        )
    ) {
        invalidateCratePlan("intention changed");
    }

    if (activePlan) return nextActiveAction(beliefs);

    const problemKey = buildProblemKey(beliefs, intentionKey, target);
    if (
        problemKey === lastFailedProblemKey
        && Date.now() - lastFailedAt < PDDL_RETRY_MS
    ) {
        return null;
    }

    const snapshot = buildProblem(beliefs, target);
    if (snapshot.error) {
        recordFailure(problemKey, snapshot.error);
        return null;
    }

    const domain = await domainTextPromise;
    if (!domain) {
        recordFailure(problemKey, "domain unavailable");
        return null;
    }

    const startedAt = Date.now();
    console.log("[pddl] solve started");
    const solverResult = await solveWithTimeout(domain, snapshot.problem);

    if (solverResult.status === "timeout") {
        recordFailure(problemKey, `solve timed out after ${PDDL_TIMEOUT_MS} ms`);
        return null;
    }
    if (solverResult.status === "rejected") {
        const errorMessage = solverResult.error instanceof Error
            ? solverResult.error.message
            : String(solverResult.error ?? "unknown error");
        recordFailure(problemKey, `solver error: ${errorMessage}`);
        return null;
    }

    const currentProblemKey = buildProblemKey(beliefs, intentionKey, target);
    if (currentProblemKey !== problemKey) {
        console.log("[pddl] solve result discarded because state changed");
        return null;
    }

    if (solverResult.plan == null) {
        recordFailure(problemKey, "solver returned no plan");
        return null;
    }

    const normalized = normalizePlan(solverResult.plan, snapshot, target);
    if (normalized.error) {
        recordFailure(problemKey, `malformed plan: ${normalized.error}`);
        return null;
    }

    activePlan = {
        problemKey,
        intentionKey,
        target: { x: target.x, y: target.y },
        actions: normalized.actions,
        nextIndex: 0,
        pendingAction: null
    };
    lastFailedProblemKey = null;
    lastFailedAt = 0;
    console.log(
        `[pddl] solve completed in ${Date.now() - startedAt} ms `
        + `with ${normalized.actions.length} actions`
    );

    return nextActiveAction(beliefs);
}

/** Advances or invalidates the active plan after its pending action outcome. */
export function reconcileCratePlanOutcome(outcome) {
    const action = outcome?.action;
    if (action?.source !== "pddl" || !activePlan?.pendingAction) return;
    if (action !== activePlan.pendingAction) return;

    if (outcome.status === "succeeded") {
        activePlan.nextIndex += 1;
        activePlan.pendingAction = null;
    } else if (outcome.status === "failed") {
        recordFailure(activePlan.problemKey, "PDDL action failed");
        invalidateCratePlan("PDDL action failed");
    }
}

/** Invalidates the single active plan, if present. */
export function invalidateCratePlan(reason) {
    if (!activePlan) return;
    activePlan = null;
    console.log(`[pddl] plan invalidated: ${reason}`);
}
