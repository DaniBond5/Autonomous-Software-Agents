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

/**
 * @typedef {Readonly<{id: number, goal: string, senderId: string}>} Mission
 */

/**
 * Puts memory, planner, replanner and executor together and drives them.
 * One mission runs to completion while only the latest later mission waits.
 */
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

        /** @type {Mission | null} */
        this.activeMission = null;

        /** @type {Mission | null} */
        this.pendingMission = null;

        this.processing = false;
        this.nextMissionId = 1;
        this.lastTurnAt = 0;
    }

    /**
     * Stores a stable mission and starts the processor when it is idle.
     * @param {string} goal
     * @param {string} senderId
     * @returns {Mission}
     */
    enqueueMission(goal, senderId) {
        if (typeof goal !== "string" || !goal.trim()) {
            throw new TypeError("mission goal must be a non-empty string");
        }
        if (typeof senderId !== "string" || !senderId.trim()) {
            throw new TypeError("mission sender must be a non-empty string");
        }

        const mission = Object.freeze({
            id: this.nextMissionId++,
            goal: goal.trim(),
            senderId,
        });

        if (this.pendingMission) {
            console.log(
                `[llm] pending mission ${this.pendingMission.id} replaced by ${mission.id}`
            );
        }
        this.pendingMission = mission;
        void this.drainMissions();
        return mission;
    }

    /** Waits out the gap between two turns. */
    async cooldown() {
        const elapsed = Date.now() - this.lastTurnAt;
        if (elapsed < MIN_TURN_INTERVAL_MS) await wait(MIN_TURN_INTERVAL_MS - elapsed);
        this.lastTurnAt = Date.now();
    }

    /**
     * Runs the active mission, then takes the latest pending one.
     * A mission error is contained here so it cannot block the next mission.
     */
    async drainMissions() {
        if (this.processing) return;
        this.processing = true;

        try {
            while (this.pendingMission) {
                const mission = this.pendingMission;
                this.pendingMission = null;
                this.activeMission = mission;

                try {
                    await this.runMission(mission);
                } catch (error) {
                    console.error(`[llm] mission ${mission.id} could not close:`, error);
                } finally {
                    this.activeMission = null;
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Runs one mission and closes all of its state before another can start.
     * @param {Mission} mission
     */
    async runMission(mission) {
        let response = INTERNAL_ERROR_MESSAGE;
        let cleanupReason = "mission failed";

        try {
            console.log(`[llm] mission ${mission.id}: ${mission.goal}`);
            this.memory.startMission(mission.goal);
            const result = await this.runMissionTurns();
            response = result.answer;
            cleanupReason = result.completed ? "mission finished" : "mission failed";
        } catch (error) {
            console.error(`[llm] mission ${mission.id} failed:`, error);
        }

        try {
            await this.executor.replyTo(mission.senderId, response);
        } catch (error) {
            console.error(`[llm] mission ${mission.id} reply failed:`, error);
        } finally {
            try {
                this.executor.cancelPendingObjective(cleanupReason);
            } finally {
                this.memory.finishMission();
            }
        }
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
