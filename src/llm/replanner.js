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
        // All three are read before any of them decides, because each reader clears its own
        // record. A trigger left unread here would still be waiting on the next turn and would
        // fire then as though it had just happened.
        const failedTool = memory.hasToolFailed();
        const goalChanged = memory.hasGoalChanged();
        const worldChanged = memory.hasWorldChanged();

        // Most urgent first, and only one wins. A failed tool means the plan is broken rather
        // than merely dated. A replaced goal means the plan answers a question nobody asked any
        // more. A changed world is last because the plan often still holds: what moved is a
        // count it was resting on.
        if (failedTool) return `the ${failedTool} tool failed`;
        if (goalChanged) return "the goal was replaced by a new one";
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
