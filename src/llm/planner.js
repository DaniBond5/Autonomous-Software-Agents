import config from "../config.js";
import { wait } from "../bdi/loop.js";
import { buildSystemPrompt } from "./executor.js";

const dbg = (...args) => {
    if (config.debug) console.log("[llm]", ...args);
};

// A turn is short on purpose. The mission is not lost when it ends: the agent
// starts another turn right after, with the world as it is by then. A long
// turn would only make the agent slow to notice that the game moved.
const MAX_ITERATIONS = 3;

// Two calls per iteration at most: one, then one more after the model has been
// reminded of the format. Beyond that the iteration is spent.
const MAX_ATTEMPTS = 2;

// The endpoint is shared with the rest of the course, so a failure is often
// temporary. After this many in a row the turn ends instead of insisting.
const MAX_API_FAILURES = 3;
const API_RETRY_MS = 1000;

const FORMAT_REMINDER = "Your last message was not in the required format. "
    + "Answer with Thought and then either Action plus Action Input, or "
    + "Final Answer. Nothing else.";

const ACTION = /^[ \t]*Action[ \t]*:[ \t]*(.+)$/m;
const ACTION_INPUT = /^[ \t]*Action Input[ \t]*:[ \t]*(.*)$/m;
const FINAL_ANSWER = /^[ \t]*Final Answer[ \t]*:[ \t]*([\s\S]*)$/m;

/**
 * @typedef {{action: string, input: string} | {action: null, answer: string}} Step
 */

/**
 * Reads the next step out of a reply.
 * An action wins over a final answer when both are present: the model cannot
 * know how the tool went before running it, so an answer written next to a
 * call it never made is a guess.
 * @param {string} text
 * @returns {Step | null} null when the reply follows neither shape
 */
export function parseStep(text) {
    const action = ACTION.exec(text ?? "");
    if (action) {
        return {
            action: action[1].trim(),
            input: (ACTION_INPUT.exec(text)?.[1] ?? "").trim(),
        };
    }

    const final = FINAL_ANSWER.exec(text ?? "");
    if (final) return { action: null, answer: final[1].trim() };

    return null;
}

/**
 * The ReAct loop: the model thinks, calls a tool, reads what happened and
 * thinks again. The format is plain text rather than the tool calling of the
 * API, so the agent works with any model behind the endpoint.
 */
export class LLMPlanner {
    /**
     * @param {import("./client.js").LLMClient} client
     */
    constructor(client) {
        this.client = client;

        /** Set when a new goal arrives, so the running turn stops quickly. */
        this.aborted = false;
    }

    /** Asks the running turn to stop at its next step. */
    abort() {
        this.aborted = true;
    }

    /**
     * Calls the model, retrying a few times when the endpoint is down.
     * @param {{role: string, content: string}[]} messages
     * @returns {Promise<string | null>} null when the endpoint kept failing
     */
    async ask(messages) {
        for (let failures = 0; failures < MAX_API_FAILURES; failures += 1) {
            if (this.aborted) return null;
            try {
                return await this.client.complete(messages);
            } catch (error) {
                console.warn(`[llm] model call failed: ${error.message}`);
                await wait(API_RETRY_MS);
            }
        }
        return null;
    }

    /**
     * Runs one turn on the current goal.
     * @param {import("./memory.js").LLMMemory} memory
     * @param {import("./executor.js").LLMExecutor} executor
     */
    async runTurn(memory, executor) {
        this.aborted = false;
        const messages = [
            { role: "system", content: buildSystemPrompt(executor) },
            { role: "user", content: memory.buildContext() },
        ];

        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
                if (this.aborted) return;

                const answer = await this.ask(messages);
                if (answer === null) {
                    console.warn("[llm] turn ended: the model could not be reached");
                    return;
                }
                messages.push({ role: "assistant", content: answer });

                const step = parseStep(answer);
                if (!step) {
                    dbg("reply in the wrong format: reminding the model");
                    messages.push({ role: "user", content: FORMAT_REMINDER });
                    continue;
                }
                if (step.action === null) {
                    dbg(`final answer: ${step.answer}`);
                    memory.remember(`concluded: ${step.answer}`);
                    return;
                }

                const observation = await executor.run(step.action, step.input);
                dbg(`observation: ${observation}`);
                // The observation goes to memory and back into the conversation:
                // memory so the next turn knows it, the conversation so this one
                // can react to it. That is what closes the loop.
                memory.remember(`${step.action} ${step.input} -> ${observation}`);
                messages.push({ role: "user", content: `Observation: ${observation}` });
                // A tool can end the mission, and then there is nothing left to
                // plan: the BDI loop is already taking over.
                if (!executor.onMission) return;
                break;
            }
        }
    }
}
