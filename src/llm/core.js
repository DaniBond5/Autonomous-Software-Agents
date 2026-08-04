import { trace } from "../utils/trace.js";

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
            trace("mission", "rejected", {
                reason: "busy",
                sender: senderId
            });
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
                trace("mission", "accepted", {
                    sender: senderId,
                    goal: missionGoal
                });
                console.log(`[llm] mission: ${missionGoal}`);
                this.memory.startMission(missionGoal);
                const result = await this.planner.runMission(
                    this.memory,
                    this.executor,
                    this.replanner
                );
                response = result.answer;
                cleanupReason = result.completed
                    ? "mission finished"
                    : "mission failed";
            } catch (error) {
                console.error("[llm] mission failed:", error);
            }

            trace("mission", "completed", {
                ok: cleanupReason === "mission finished",
                answer: response
            });
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
}
