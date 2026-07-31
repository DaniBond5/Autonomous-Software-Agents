import OpenAI from "openai";

import config from "../config.js";

/**
 * Thin wrapper around the OpenAI-compatible endpoint.
 * It exists so the rest of the agent never touches the vendor SDK: swapping
 * the university gateway for a local model is a change to this file only.
 */
export class LLMClient {
    /**
     * @param {{baseUrl: string, apiKey: string, model: string, temperature: number}} [settings]
     */
    constructor(settings = config.llm) {
        this.model = settings.model;
        this.temperature = settings.temperature;
        this.client = new OpenAI({
            baseURL: settings.baseUrl,
            apiKey: settings.apiKey,
        });
    }

    /**
     * Sends a conversation and returns the raw text of the reply.
     * Errors are left to the caller: only the planner knows how many failures
     * are worth retrying before the turn is dropped.
     * @param {{role: string, content: string}[]} messages
     * @returns {Promise<string>}
     */
    async complete(messages) {
        const completion = await this.client.chat.completions.create({
            model: this.model,
            temperature: this.temperature,
            messages,
        });
        return completion.choices[0]?.message?.content ?? "";
    }
}
