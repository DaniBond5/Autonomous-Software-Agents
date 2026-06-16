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

/**
 * TODO: initial version, there may be a simpler way to do this.
 * This function performs a Breadth First Search given the beliefs of an agent and a goal tile.
 * If either the beliefs or the goal tile are undefined, it returns false.
 * If the given goal tile is not traversable, it returns false.
 * If goalTile corresponds to the agent's current position it returns the goalTile.
 * If during the search the goal tile has been found, an array containing the sequence of tiles visited is returned.
 * If goalTile is not found by the search, false is returned.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs 
 * @param {import("@unitn-asa/deliveroo-js-sdk").IOTile} goalTile 
 * @returns false if search has failed, or the path to the goal tile given the agent's current position.
 */
export function BFS(beliefs, goalTile) {
    if(!beliefs || !goalTile) return false;
    if (!isPositionTraversable(beliefs, goalTile)) return false

    let startingPosition = beliefs.me.pos;
    if (goalTile.x == startingPosition.x && goalTile.y == startingPosition.y) return goalTile;

    let frontier = [];
    frontier.push({x: startingPosition.x, y: startingPosition.y, path: []});
    let reached = new Set();
    reached.add(`${startingPosition.x},${startingPosition.y}`);
    
    while(frontier.length > 0) {
        const {x, y, path} = frontier.shift();

        const neighbors = getNeighbors(beliefs, {x: x, y: y});

        for (const neighbor of neighbors) {
            if (neighbor.x == goalTile.x && neighbor.y == goalTile.y) return [...path, {x: goalTile.x, y: goalTile.y}];
            if (!reached.has(`${neighbor.x},${neighbor.y}`)) {
                reached.add(`${neighbor.x},${neighbor.y}`);
                frontier.push({x: neighbor.x, y: neighbor.y, path: [...path, {x: neighbor.x, y: neighbor.y}]});
            }
        }
    }
    return false;
}

/**
 * This function checks if a given position is traversable.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs 
 * @param {{x: number, y: number}} position
 * @returns false if the given position is not traversable by the agent or true if it is.
 */
export function isPositionTraversable(beliefs, {x: positionX, y: positionY}) {
    if (!beliefs.world.tiles.has(`${positionX},${positionY}`)) return false;
    if (beliefs.world.tiles.get(`${positionX},${positionY}`).type == 0 ) return false;
    return positionX >= 0 && positionX < beliefs.world.width && positionY >= 0 && positionY < beliefs.world.height;
}

/**
 * This function returns an array of neighboring positions given one.
 * @param {import("../bdi/beliefs.js").beliefs} beliefs 
 * @param {{x: number, y: number}} position 
 * @returns an array of the neighboring position of the one given as an argument.
 */
export function getNeighbors(beliefs, {x: positionX, y: positionY}) {
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

        if(isPositionTraversable(beliefs, {x: neighborX, y: neighborY})) neighbors.push({x: neighborX, y: neighborY});
    }
    return neighbors;
}