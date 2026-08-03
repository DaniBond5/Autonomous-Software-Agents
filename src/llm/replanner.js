/**
 * Consumes one semantic failure and asks the model for another approach.
 */
export class LLMReplanner {
    /**
     * Returns one concrete reason, then removes it from memory.
     * @param {import("./memory.js").LLMMemory} memory
     * @returns {string | null} why to replan, or null when nothing changed
     */
    shouldReplan(memory) {
        return memory.takeReplanReason();
    }

    /**
     * Records why the plan is being rebuilt, then runs the next turn on the
     * state as it is now.
     * @param {import("./memory.js").LLMMemory} memory
     * @param {import("./planner.js").LLMPlanner} planner
     * @param {import("./executor.js").LLMExecutor} executor
     * @param {string} reason what changed, from shouldReplan
     * @returns {Promise<import("./planner.js").TurnOutcome>} how the turn ended, so the
     *          caller counts a replanned turn the same as any other.
     */
    async replan(memory, planner, executor, reason) {
        console.log(`[llm] replanning: ${reason}`);
        memory.remember(
            `The previous step could not be completed: ${reason}. `
            + "Choose a different valid approach."
        );
        return planner.runTurn(memory, executor);
    }
}
