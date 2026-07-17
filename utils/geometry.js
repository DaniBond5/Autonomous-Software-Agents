/**
 * Calculates the Manhattan distance between two grid coordinates.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
export function distance({x: x1, y: y1}, {x: x2, y: y2}) {
    const dx = Math.abs(Math.round(x1) - Math.round(x2));
    const dy = Math.abs(Math.round(y1) - Math.round(y2));
    return dx + dy;
}

const directionalTiles = {
    '↑': { dx: 0, dy: 1 },
    '→': { dx: 1, dy: 0 },
    '↓': { dx: 0, dy: -1 },
    '←': { dx: -1, dy: 0 },
};

const positionKey = ({ x, y }) => `${x},${y}`;

/**
 * @typedef {Object} PathfindingOptions
 * @property {function({x: number, y: number}): boolean} [isBlocked]
 */

/**
 * @typedef {Object} ShortestPaths
 * @property {{x: number, y: number}} start
 * @property {Map<string, number>} distances
 * @property {Map<string, {x: number, y: number}>} predecessors
 */

/**
 * Computes shortest paths from one position to every reachable tile.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs
 * @param {{x: number, y: number}} start
 * @param {PathfindingOptions} [options]
 * @returns {ShortestPaths | null}
 */
export function shortestPathsFrom(beliefs, start, options = {}) {
    if (!beliefs || !start || !isPositionTraversable(beliefs, start)) return null;

    const startingPosition = { x: start.x, y: start.y };
    const startKey = positionKey(startingPosition);
    const distances = new Map([[startKey, 0]]);
    const predecessors = new Map();
    const frontier = [startingPosition];
    let frontierIndex = 0;

    while (frontierIndex < frontier.length) {
        const current = frontier[frontierIndex++];
        const currentDistance = distances.get(positionKey(current));

        for (const neighbor of getNeighbors(beliefs, current, options)) {
            const neighborKey = positionKey(neighbor);
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
    return search.distances.get(positionKey(target)) ?? Infinity;
}

/**
 * Reconstructs the shortest path to a target from an existing search.
 * @param {ShortestPaths | null} search
 * @param {{x: number, y: number}} target
 * @returns {false | {x: number, y: number}[]} false if unreachable, otherwise the path (empty at start)
 */
export function pathFromSearch(search, target) {
    if (!Number.isFinite(distanceFromSearch(search, target))) return false;

    const path = [];
    const startKey = positionKey(search.start);
    let current = { x: target.x, y: target.y };

    while (positionKey(current) !== startKey) {
        path.push(current);
        current = search.predecessors.get(positionKey(current));
    }

    return path.reverse();
}

/**
 * Performs a Breadth First Search from an optional starting position to a goal.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOTile} goalTile
 * @param {PathfindingOptions & {startingPosition?: {x: number, y: number}}} [options]
 * @returns {false | {x: number, y: number}[]} false if unreachable, otherwise the path (empty at the goal)
 */
export function BFS(beliefs, goalTile, options = {}) {
    if (!goalTile) return false;
    const startingPosition = options.startingPosition ?? beliefs?.me?.pos;
    return pathFromSearch(shortestPathsFrom(beliefs, startingPosition, options), goalTile);
}

/**
 * This function checks if a given position is traversable.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs 
 * @param {{x: number, y: number}} position
 * @returns false if the given position is not traversable by the agent or true if it is.
 */
export function isPositionTraversable(beliefs, {x: positionX, y: positionY}) {
    const tile = beliefs.world.tiles.get(`${positionX},${positionY}`);
    return tile != null && tile.type != 0;
}

/**
 * Checks whether a move follows map adjacency, traversability and destination direction.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @returns {boolean}
 */
export function isMoveAllowed(beliefs, from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1 || !isPositionTraversable(beliefs, to)) return false;

    const destinationDirection = directionalTiles[beliefs.world.tiles.get(positionKey(to)).type];
    return !destinationDirection
        || dx !== -destinationDirection.dx
        || dy !== -destinationDirection.dy;
}

/**
 * This function returns an array of neighboring positions given one.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs 
 * @param {{x: number, y: number}} position
 * @param {PathfindingOptions} [options]
 * @returns an array of the neighboring position of the one given as an argument.
 */
export function getNeighbors(beliefs, {x: positionX, y: positionY}, options = {}) {
    let neighbors = [];
    
    const directions = [
        {dx: 1, dy: 0},
        {dx: -1, dy:0},
        {dx: 0, dy: 1},
        {dx: 0, dy: -1}
    ];

    for (const direction of directions) {
        let neighborX = positionX + direction.dx;
        let neighborY = positionY + direction.dy;
        const neighbor = { x: neighborX, y: neighborY };

        if (isMoveAllowed(beliefs, { x: positionX, y: positionY }, neighbor)
            && !options.isBlocked?.(neighbor)) neighbors.push(neighbor);
    }
    return neighbors;
}
