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

    pddl: {
        timeoutMs: 10_000,
        retryMs: 5_000,
    },
};

export default config;
