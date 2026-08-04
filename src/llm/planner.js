import config from "../config.js";
import { wait } from "../bdi/loop.js";
import { buildSystemPrompt } from "./executor.js";

const dbg = (...args) => {
    if (config.debug) console.log("[llm]", ...args);
};

const MAX_STEPS = 10;
// Bound the LLM execution loop even when the model never reaches a final answer.

// The endpoint is shared with the rest of the course, so a failure is often
// temporary. After this many in a row the mission stops instead of insisting.
const MAX_API_FAILURES = 3;
const API_RETRY_MS = 1000;

const COMPLETED_FALLBACK = "Mission completed.";
const MAX_STEPS_MESSAGE =
    "Mission stopped: maximum number of LLM turns reached.";
const UNREACHABLE_MESSAGE =
    "Mission stopped: the language model could not be reached.";

const FORMAT_REMINDER = "Your last message was not in the required format. "
    + "Answer with Thought and then either Action plus Action Input, or "
    + "Final Answer. Nothing else.";

const ACTION = /^[ \t]*Action[ \t]*:[ \t]*(.+)$/m;
const ACTION_INPUT = /^[ \t]*Action Input[ \t]*:[ \t]*(.*)$/m;
const FINAL_ANSWER = /^[ \t]*Final Answer[ \t]*:[ \t]*([\s\S]*)$/m;

/**
 * @typedef {{action: string, input: string} | {action: null, answer: string}} Step
 */

// An action wins over a final answer because the tool result is not known yet.
/** @returns {Step | null} */
function parseStep(text) {
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

export class LLMPlanner {
    constructor(client) {
        this.client = client;
    }

    async ask(messages) {
        for (let failures = 0; failures < MAX_API_FAILURES; failures += 1) {
            try {
                return await this.client.complete(messages);
            } catch (error) {
                console.warn(`[llm] model call failed: ${error.message}`);
                if (failures + 1 < MAX_API_FAILURES) await wait(API_RETRY_MS);
            }
        }
        return null;
    }

    async runMission(memory, executor, replanner) {
        for (let stepNumber = 0; stepNumber < MAX_STEPS; stepNumber += 1) {
            const messages = [
                { role: "system", content: buildSystemPrompt(executor) },
                { role: "user", content: memory.buildContext() },
            ];
            const answer = await this.ask(messages);
            if (answer === null) {
                return { answer: UNREACHABLE_MESSAGE, completed: false };
            }

            const parsed = parseStep(answer);
            if (!parsed) {
                dbg("reply in the wrong format");
                memory.remember(FORMAT_REMINDER);
                continue;
            }
            if (parsed.action === null) {
                const finalAnswer = parsed.answer.trim() || COMPLETED_FALLBACK;
                dbg(`final answer: ${finalAnswer}`);
                memory.remember(`concluded: ${finalAnswer}`);
                return { answer: finalAnswer, completed: true };
            }

            const result = await executor.run(parsed.action, parsed.input);
            dbg(`tool result: ${result.text}`);
            const toolCall = parsed.input
                ? `${parsed.action} ${parsed.input}`
                : parsed.action;
            if (result.ok) {
                memory.remember(`${toolCall} -> ${result.text}`);
            } else {
                replanner.replan(
                    memory,
                    parsed.action,
                    parsed.input,
                    result.text
                );
            }
        }
        return { answer: MAX_STEPS_MESSAGE, completed: false };
    }
}
