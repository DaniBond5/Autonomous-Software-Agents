import { generateDesires } from "./desires.js";

/**
 * Deliberation step: out of all current desires, pick the one with the
 * highest utility. Returns null when there is nothing worth doing.
 * @param {import("./beliefs.js").beliefs} beliefs
 * @returns {import("./desires.js").Desire | null}
 */
export function selectIntention(beliefs) {
    const desires = generateDesires(beliefs);
    if (desires.length === 0) return null;

    let best = desires[0];
    for (const d of desires) {
        if (d.utility > best.utility) best = d;
    }
    return best;
}

/**
 * Execution step. 
 * @param {import("./beliefs.js").beliefs} beliefs
 * @param {import("./desires.js").Desire} intention
 */
export async function executeIntention(beliefs, intention) {
    console.log(`[INTENTION] ${intention.type} -> (${intention.target.x}, ${intention.target.y}) | utility ${intention.utility.toFixed(2)}`);
    // TODO (next step): move one step toward intention.target, then perform
    // the terminal action based on intention.type
}