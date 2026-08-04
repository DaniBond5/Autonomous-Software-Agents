export class LLMReplanner {
    /**
     * @param {import("./memory.js").LLMMemory} memory
     * @param {string} action
     * @param {string} input
     * @param {string} observation
     * @param {string} reason
     */
    replan(memory, action, input, observation, reason) {
        const actionName = String(action ?? "").trim();
        const actionInput = String(input ?? "").trim();
        const tool = actionInput ? `${actionName} ${actionInput}` : actionName;
        const result = String(observation ?? "").trim();
        const concreteReason = String(reason ?? "").trim();

        console.log(`[llm] replanning: ${concreteReason}`);
        memory.remember(
            `Previous action ${tool} failed: ${result}. `
            + `Reason: ${concreteReason}. Choose a different valid approach.`
        );
    }
}
