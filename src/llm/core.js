import { wait } from "../bdi/loop.js";

// A turn is several calls to the model. Starting the next one immediately
// would hammer the endpoint for a game that has barely moved in between.
const MIN_TURN_INTERVAL_MS = 1000;

const MAX_TURNS_PER_MISSION = 10;
const MAX_UNREACHABLE_TURNS = 3;

const COMPLETED_FALLBACK = "Mission completed.";
const MAX_TURNS_MESSAGE = "Mission stopped: maximum number of LLM turns reached.";
const UNREACHABLE_MESSAGE = "Mission stopped: the language model could not be reached.";
const INTERNAL_ERROR_MESSAGE = "Mission stopped because of an internal error.";
const BUSY_MESSAGE = "Busy: another mission is already running.";

/** Puts memory, planner, replanner and executor together and drives them. */
export class LLMAgent {
    /**
     * @param {{memory: import("./memory.js").LLMMemory,
     *          planner: import("./planner.js").LLMPlanner,
     *          replanner: import("./replanner.js").LLMReplanner,
     *          executor: import("./executor.js").LLMExecutor}} parts
     */
    constructor({ memory, planner, replanner, executor }) {
        this.memory = memory;
        this.planner = planner;
        this.replanner = replanner;
        this.executor = executor;

        this.busy = false;
        this.lastTurnAt = 0;
    }

    /**
     * Runs one mission or immediately tells its sender that the agent is busy.
     * @param {string} goal
     * @param {string} senderId
     */
    async handleMission(goal, senderId) {
        if (typeof goal !== "string" || !goal.trim()) {
            throw new TypeError("mission goal must be a non-empty string");
        }
        if (typeof senderId !== "string" || !senderId.trim()) {
            throw new TypeError("mission sender must be a non-empty string");
        }

        if (this.busy) {
            try {
                await this.executor.replyTo(senderId, BUSY_MESSAGE);
            } catch (error) {
                console.error("[llm] reply failed:", error);
            }
            return;
        }

        this.busy = true;
        let response = INTERNAL_ERROR_MESSAGE;
        let cleanupReason = "mission failed";
        try {
            try {
                const missionGoal = goal.trim();
                console.log(`[llm] mission: ${missionGoal}`);
                this.memory.startMission(missionGoal);
                const result = await this.runMissionTurns();
                response = result.answer;
                cleanupReason = result.completed
                    ? "mission finished"
                    : "mission failed";
            } catch (error) {
                console.error("[llm] mission failed:", error);
            }

            try {
                await this.executor.replyTo(senderId, response);
            } catch (error) {
                console.error("[llm] reply failed:", error);
            }
        } finally {
            try {
                this.executor.cancelPendingObjective(cleanupReason);
            } catch (error) {
                console.error("[llm] mission failed:", error);
            }
            try {
                this.memory.finishMission();
            } catch (error) {
                console.error("[llm] mission failed:", error);
            }
            this.busy = false;
        }
    }

    /** Waits out the gap between two turns. */
    async cooldown() {
        const elapsed = Date.now() - this.lastTurnAt;
        if (elapsed < MIN_TURN_INTERVAL_MS) await wait(MIN_TURN_INTERVAL_MS - elapsed);
        this.lastTurnAt = Date.now();
    }

    /**
     * Runs bounded turns until the model returns a final answer.
     * @returns {Promise<{answer: string, completed: boolean}>}
     */
    async runMissionTurns() {
        let turns = 0;
        let unreachableTurns = 0;

        while (turns < MAX_TURNS_PER_MISSION) {
            await this.cooldown();
            turns += 1;

            const reason = this.replanner.shouldReplan(this.memory);
            const outcome = reason
                ? await this.replanner.replan(
                    this.memory, this.planner, this.executor, reason
                )
                : await this.planner.runTurn(this.memory, this.executor);

            if (outcome.status === "unreachable") {
                unreachableTurns += 1;
                if (unreachableTurns >= MAX_UNREACHABLE_TURNS) {
                    return { answer: UNREACHABLE_MESSAGE, completed: false };
                }
                continue;
            }

            unreachableTurns = 0;
            if (outcome.status === "answered") {
                return {
                    answer: outcome.answer || COMPLETED_FALLBACK,
                    completed: true,
                };
            }
        }

        return { answer: MAX_TURNS_MESSAGE, completed: false };
    }
}
