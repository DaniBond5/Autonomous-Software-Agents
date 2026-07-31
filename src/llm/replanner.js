/**
 * Decides when a plan has to be rebuilt, and says why.
 * The reason is written into the history, which is part of the context, so the
 * model reads what changed before it plans again instead of starting over
 * blind. This is the reflection step of the agent.
 */
export class LLMReplanner {
    /**
     * @param {import("./memory.js").LLMMemory} memory
     * @returns {boolean} whether the world moved enough to plan again
     */
    shouldReplan(memory) {
        return memory.hasWorldChanged();
    }

    /**
     * Records why the plan is being rebuilt, then runs the next turn on the
     * state as it is now.
     * @param {import("./memory.js").LLMMemory} memory
     * @param {import("./planner.js").LLMPlanner} planner
     * @param {import("./executor.js").LLMExecutor} executor
     */
    async replan(memory, planner, executor) {
        const reason = `the world changed: now carrying ${memory.snapshot.carried} parcels`;
        console.log(`[llm] replanning, ${reason}`);
        memory.remember(`replanning because ${reason}`);
        await planner.runTurn(memory, executor);
    }
}
