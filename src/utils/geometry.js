import { POSITION_KEY } from "../bdi/beliefs.js";

const directionalTiles = {
    '↑': { dx: 0, dy: 1 },
    '→': { dx: 1, dy: 0 },
    '↓': { dx: 0, dy: -1 },
    '←': { dx: -1, dy: 0 },
};

const CARDINAL_DIRECTIONS = Object.freeze([
    Object.freeze({ dx: 1, dy: 0 }),
    Object.freeze({ dx: -1, dy: 0 }),
    Object.freeze({ dx: 0, dy: 1 }),
    Object.freeze({ dx: 0, dy: -1 }),
]);


/**
 * @typedef {Object} PathfindingOptions
 * @property {function({x: number, y: number}): boolean} [isBlocked]
 * @property {boolean} [ignoreAvoided] cross tiles a mission forbade, used only by the retry
 *           in desire generation when avoiding them leaves nothing reachable
 */

/**
 * @typedef {Object} ShortestPaths
 * @property {{x: number, y: number}} start
 * @property {Map<string, number>} distances
 * @property {Map<string, {x: number, y: number}>} predecessors
 */

/**
 * Computes shortest paths from one position to every reachable tile.
 * @param {import("../bdi/beliefs.js").Beliefs} beliefs
 * @param {{x: number, y: number}} start
 * @param {PathfindingOptions} [options]
 * @returns {ShortestPaths | null}
 */
export function shortestPathsFrom(beliefs, start, options = {}) {
    if (!beliefs || !start || !isPositionTraversable(beliefs, start)) return null;

    const startingPosition = { x: start.x, y: start.y };
    const startKey = POSITION_KEY(startingPosition);
    const distances = new Map([[startKey, 0]]);
    const predecessors = new Map();
    const frontier = [startingPosition];
    let frontierIndex = 0;

    while (frontierIndex < frontier.length) {
        const current = frontier[frontierIndex++];
        const currentDistance = distances.get(POSITION_KEY(current));

        for (const neighbor of getNeighbors(beliefs, current, options)) {
            const neighborKey = POSITION_KEY(neighbor);
            if (distances.has(neighborKey)) continue;

            distances.set(neighborKey, currentDistance + 1);
            predecessors.set(neighborKey, current);
            frontier.push(neighbor);
        }
    }

    return { start: startingPosition, distances, predecessors };
}

/**
 * Returns the shortest-path distance to a target from an existing search.
 * @param {ShortestPaths | null} search
 * @param {{x: number, y: number}} target
 * @returns {number} path length, or Infinity when the target is unreachable
 */
export function distanceFromSearch(search, target) {
    if (!search || !target) return Infinity;
    return search.distances.get(POSITION_KEY(target)) ?? Infinity;
}

/**
 * Reconstructs the shortest path to a target from an existing search.
 * @param {ShortestPaths | null} search
 * @param {{x: number, y: number}} target
 * @returns {false | {x: number, y: number}[]} false if unreachable, otherwise the path (empty at start)
 */
function pathFromSearch(search, target) {
    if (!Number.isFinite(distanceFromSearch(search, target))) return false;

    const path = [];
    const startKey = POSITION_KEY(search.start);
    let current = { x: target.x, y: target.y };

    while (POSITION_KEY(current) !== startKey) {
        path.push(current);
        current = search.predecessors.get(POSITION_KEY(current));
    }

    return path.reverse();
}

/**
 * Performs a Breadth First Search from an optional starting position to a goal.
 * @param {import("../bdi/beliefs.js").Beliefs} beliefs
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOTile} goalTile
 * @param {PathfindingOptions & {startingPosition?: {x: number, y: number}}} [options]
 * @returns {false | {x: number, y: number}[]} false if unreachable, otherwise the path (empty at the goal)
 */
export function BFS(beliefs, goalTile, options = {}) {
    if (!goalTile) return false;
    const startingPosition = options.startingPosition ?? beliefs?.me?.pos;
    if (!beliefs || !startingPosition
        || !isPositionTraversable(beliefs, startingPosition)) return false;

    const start = { x: startingPosition.x, y: startingPosition.y };
    const startKey = POSITION_KEY(start);
    const goalKey = POSITION_KEY(goalTile);
    if (startKey === goalKey) return [];

    const search = {
        start,
        distances: new Map([[startKey, 0]]),
        predecessors: new Map(),
    };
    const frontier = [start];
    let frontierIndex = 0;

    while (frontierIndex < frontier.length) {
        const current = frontier[frontierIndex++];
        const currentDistance = search.distances.get(POSITION_KEY(current));

        for (const neighbor of getNeighbors(beliefs, current, options)) {
            const neighborKey = POSITION_KEY(neighbor);
            if (search.distances.has(neighborKey)) continue;

            search.distances.set(neighborKey, currentDistance + 1);
            search.predecessors.set(neighborKey, current);
            if (neighborKey === goalKey) {
                return pathFromSearch(search, goalTile);
            }
            frontier.push(neighbor);
        }
    }

    return false;
}

/**
 * A tile is traversable when it exists and is not a wall.
 * @param {import("../bdi/beliefs.js").Beliefs} beliefs
 * @param {{x: number, y: number}} position
 * @returns {boolean}
 */
export function isPositionTraversable(beliefs, {x: positionX, y: positionY}) {
    const tile = beliefs.world.tiles.get(`${positionX},${positionY}`);
    return tile != null && tile.type != 0;
}

/**
 * Checks whether a move follows map adjacency, traversability and destination direction.
 * @param {import("../bdi/beliefs.js").Beliefs} beliefs
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @returns {boolean}
 */
export function isMoveAllowed(beliefs, from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1 || !isPositionTraversable(beliefs, to)) return false;

    const destinationDirection = directionalTiles[beliefs.world.tiles.get(POSITION_KEY(to)).type];
    return !destinationDirection
        || dx !== -destinationDirection.dx
        || dy !== -destinationDirection.dy;
}

/** Checks whether three tiles form a valid push line on the static map. */
export function isPushGeometryAllowed(
    beliefs,
    behind,
    cratePosition,
    destination
) {
    const positions = [behind, cratePosition, destination];
    if (!beliefs || positions.some(position =>
        !Number.isInteger(position?.x) || !Number.isInteger(position?.y))) {
        return false;
    }

    const firstDx = cratePosition.x - behind.x;
    const firstDy = cratePosition.y - behind.y;
    const secondDx = destination.x - cratePosition.x;
    const secondDy = destination.y - cratePosition.y;
    return Math.abs(firstDx) + Math.abs(firstDy) === 1
        && firstDx === secondDx
        && firstDy === secondDy
        && isPositionTraversable(beliefs, behind)
        && isPositionTraversable(beliefs, destination)
        && isMoveAllowed(beliefs, behind, cratePosition)
        && beliefs.world.isCrateSpace(cratePosition)
        && beliefs.world.isCrateSpace(destination);
}

/** Checks whether a geometrically valid push applies to the current crates. */
export function isPushTransitionAllowed(
    beliefs,
    behind,
    cratePosition,
    destination
) {
    return isPushGeometryAllowed(beliefs, behind, cratePosition, destination)
        && beliefs.crates.getAt(cratePosition) != null
        && !beliefs.crates.isOccupied(destination);
}

/**
 * Finds a directed corridor whose crate crossings have a valid initial push.
 * It selects entry/exit for PDDL without simulating subsequent crate states.
 * @param {import("../bdi/beliefs.js").Beliefs} beliefs
 * @param {{x: number, y: number}} goalTile
 * @returns {false | {entry:{x:number,y:number},exit:{x:number,y:number}}}
 */
export function findCrateCorridor(beliefs, goalTile) {
    const startingPosition = beliefs?.me?.pos;
    if (!goalTile || !startingPosition
        || !isPositionTraversable(beliefs, startingPosition)) return false;

    const start = { x: startingPosition.x, y: startingPosition.y };
    const startKey = POSITION_KEY(start);
    const goalKey = POSITION_KEY(goalTile);
    if (startKey === goalKey) return false;

    const search = {
        start,
        distances: new Map([[startKey, 0]]),
        predecessors: new Map(),
    };
    const frontier = [start];
    let frontierIndex = 0;

    while (frontierIndex < frontier.length) {
        const current = frontier[frontierIndex++];
        const currentDistance = search.distances.get(POSITION_KEY(current));

        for (const { dx, dy } of CARDINAL_DIRECTIONS) {
            const neighbor = { x: current.x + dx, y: current.y + dy };
            const crate = beliefs.crates.getAt(neighbor);
            const allowed = crate
                ? isPushTransitionAllowed(
                    beliefs,
                    current,
                    neighbor,
                    { x: neighbor.x + dx, y: neighbor.y + dy }
                )
                : isMoveAllowed(beliefs, current, neighbor);
            if (!allowed) continue;

            const neighborKey = POSITION_KEY(neighbor);
            if (search.distances.has(neighborKey)) continue;

            search.distances.set(neighborKey, currentDistance + 1);
            search.predecessors.set(neighborKey, current);
            if (neighborKey === goalKey) {
                const path = pathFromSearch(search, goalTile);
                return crateCorridorFromPath(beliefs, start, path);
            }
            frontier.push(neighbor);
        }
    }

    return false;
}

function crateCorridorFromPath(beliefs, start, path) {
    let firstCrateIndex = -1;
    let lastCrateIndex = -1;

    for (let index = 0; index < path.length; index += 1) {
        if (!beliefs.crates.isOccupied(path[index])) continue;
        if (firstCrateIndex < 0) firstCrateIndex = index;
        lastCrateIndex = index;
    }

    if (firstCrateIndex < 0) return false;
    const entry = firstCrateIndex === 0 ? start : path[firstCrateIndex - 1];
    const exit = path[lastCrateIndex + 1];
    if (!exit
        || !isPositionTraversable(beliefs, exit)
        || beliefs.crates.isOccupied(exit)) return false;

    return {
        entry: { x: entry.x, y: entry.y },
        exit: { x: exit.x, y: exit.y },
    };
}

/**
 * @param {import("../bdi/beliefs.js").Beliefs} beliefs
 * @param {{x: number, y: number}} position
 * @param {PathfindingOptions} [options]
 * @returns {{x: number, y: number}[]}
 */
function getNeighbors(beliefs, position, options = {}) {
    const neighbors = [];

    for (const { dx, dy } of CARDINAL_DIRECTIONS) {
        const neighbor = {
            x: position.x + dx,
            y: position.y + dy
        };

        // A tile a mission forbade is dropped here rather than in each caller, which is what
        // makes the ban hold for every search in the codebase without any of them being
        // changed. It is a hard exclusion and not a cost, because the search is uniform-cost
        // breadth-first: a penalty would mean Dijkstra, to buy a decision the retry in desire
        // generation already reaches.
        const isAvoided = !options.ignoreAvoided
            && beliefs.rules.isAvoided(neighbor);

        if (isMoveAllowed(beliefs, position, neighbor)
            && !options.isBlocked?.(neighbor)
            && !isAvoided) neighbors.push(neighbor);
    }
    return neighbors;
}
