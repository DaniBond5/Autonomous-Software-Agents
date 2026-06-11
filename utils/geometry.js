/**
 * Calculates the Manhattan distance between two grid coordinates.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
function distance({x: x1, y: y1}, {x: x2, y: y2}) {
    const dx = Math.abs(Math.round(x1) - Math.round(x2));
    const dy = Math.abs(Math.round(y1) - Math.round(y2));
    return dx + dy;
}

export { distance }