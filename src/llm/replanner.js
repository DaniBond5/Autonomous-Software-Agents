/**
 * Decides when a plan has to be rebuilt, and says why.
 * The reason is written into the history, which is part of the context, so the
 * model reads what changed before it plans again instead of starting over
 * blind. This is the reflection step of the agent.
 */
export class LLMReplanner {
    /**
     * Whether anything has happened that the model should reconsider its approach over.
     * @param {import("./memory.js").LLMMemory} memory
     * @returns {string | null} why to replan, or null when nothing changed
     */
    shouldReplan(memory) {
        // Both are read because each check refreshes its own pending state.
        const failedTool = memory.hasToolFailed();
        const worldChanged = memory.hasWorldChanged();

        // A failed tool invalidates the approach more directly than a changed parcel count.
        if (failedTool) return `the ${failedTool} tool failed`;
        if (worldChanged) return `you are now carrying ${memory.snapshot.carried} parcels`;
        return null;
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
        // Phrased as an instruction rather than a note, because this sentence is the whole of
        // the reflection step: the model reads it in the next context and is asked to question
        // its approach, instead of quietly trying again what has just stopped working.
        memory.remember(`${reason}. Reconsider whether your approach still holds.`);
        return planner.runTurn(memory, executor);
    }
}
