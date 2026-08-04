export class LLMReplanner {
    /**
     * @param {import("./memory.js").LLMMemory} memory
     * @param {string} action
     * @param {string} input
     * @param {string} reason
     */
    replan(memory, action, input, reason) {
        const tool = input ? `${action} ${input}` : action;
        const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;

        console.log(`[llm] replanning: ${reason}`);
        memory.remember(
            `Previous action ${tool} failed: ${sentence} `
            + "Choose a different valid approach."
        );
    }
}
