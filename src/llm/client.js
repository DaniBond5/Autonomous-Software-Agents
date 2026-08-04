import OpenAI from "openai";

import config from "../config.js";

/** Keeps the vendor SDK behind one OpenAI-compatible client. */
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
     * Returns raw model text and leaves retry decisions to the planner.
     * @param {{role:string,content:string}[]} messages
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
