import "dotenv/config";

// Connection credentials stay in the environment.
const config = {
    deliveroo: {
        host: process.env.HOST,
        agents: {
            bdi: {
                token: process.env.TOKEN,
            },
            llm: {
                token: process.env.LLM_TOKEN || null,
            },
        },
    },

    debug: true,

    llm: {
        baseUrl: process.env.LITELLM_BASE_URL,
        apiKey: process.env.LITELLM_API_KEY,
        model: process.env.LOCAL_MODEL,

        // Missions ask for precision, not creativity: the model has to read
        // coordinates and rewards, not invent them.
        temperature: 0.1,

        // Optional name or id: when set, only that player can send missions.
        // Useful to ignore the chat of everyone else during a test.
        missionSender: process.env.MISSION_SENDER || null,
    },

    pddl: {
        timeoutMs: 10_000,
        retryMs: 5_000,
    },
};

export default config;
