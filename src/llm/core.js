import { wait } from "../bdi/loop.js";

/**
 * Ordinary play is stated as a goal like any other, so the agent has one way
 * of working and not two: a mission that ends simply returns to this goal.
 */
export const DEFAULT_GOAL = "No one has asked you for anything. Play the game "
    + "on your own: go back to autonomous play so you can collect parcels and "
    + "deliver them for points.";

// A turn is several calls to the model. Starting the next one immediately
// would hammer the endpoint for a game that has barely moved in between.
const MIN_TURN_INTERVAL_MS = 1000;

// A mission ends when a tool ends it, and nothing guarantees a tool ever does.
// The three bounds below are the three ways that was seen to fail.

// The model keeps calling tools and never calls resume_autonomous. Ten turns is
// far more than the few any published mission needs, so hitting this is a fault.
const MAX_TURNS_PER_MISSION = 10;

// The endpoint is down, and every turn ends the same way. Without this the agent
// retries for as long as the process lives, and the endpoint is shared with the
// whole course.
const MAX_UNREACHABLE_TURNS = 3;

/**
 * Puts memory, planner, replanner and executor together and drives them.
 * It owns the timing: one turn at a time, spaced out, and a new goal takes
 * over from the one being worked on.
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

        /** True while turns are running, so two of them never overlap. */
        this.running = false;

        this.lastTurnAt = 0;
    }

    /**
     * Takes a goal in natural language and starts working on it.
     * @param {string} goal
     * @param {string | null} senderId who asked, or null for the default goal
     */
    async setGoal(goal, senderId) {
        console.log(`[llm] goal: ${goal}`);
        this.memory.setGoal(goal);
        this.executor.beginMission(senderId);

        if (this.running) {
            // The turn under way is about the old goal. Stopping it lets the
            // loop that owns it pick the new one up on its next step.
            this.planner.abort();
            return;
        }
        await this.run();
    }

    /** Waits out the gap between two turns. */
    async cooldown() {
        const elapsed = Date.now() - this.lastTurnAt;
        if (elapsed < MIN_TURN_INTERVAL_MS) await wait(MIN_TURN_INTERVAL_MS - elapsed);
        this.lastTurnAt = Date.now();
    }

    /**
     * Ends the mission and writes the reason into memory, so a later turn reads
     * why it was stopped instead of starting the same mission over.
     * @param {string} reason
     */
    stopMission(reason) {
        this.memory.remember(this.executor.leaveMission(reason));
    }

    /**
     * Runs turns until a tool hands control back to autonomous play.
     * A turn is capped, so a mission normally takes a few of them; before each
     * one the replanner says whether the world moved in the meantime.
     * The three exits below are what make "until a tool hands control back" true:
     * the default goal means the agent is on a mission even when nobody asked it
     * anything, so a mission that cannot end is the agent never playing again.
     */
    async run() {
        this.running = true;
        let turns = 0;
        let unreachableTurns = 0;
        try {
            while (this.executor.onMission) {
                if (turns >= MAX_TURNS_PER_MISSION) {
                    this.stopMission(`stopped after ${MAX_TURNS_PER_MISSION} turns`);
                    break;
                }
                await this.cooldown();
                turns += 1;

                const outcome = this.replanner.shouldReplan(this.memory)
                    ? await this.replanner.replan(this.memory, this.planner, this.executor)
                    : await this.planner.runTurn(this.memory, this.executor);

                if (outcome === "unreachable") {
                    unreachableTurns += 1;
                    if (unreachableTurns >= MAX_UNREACHABLE_TURNS) {
                        this.stopMission(
                            `stopped after ${MAX_UNREACHABLE_TURNS} turns without reaching the model`
                        );
                        break;
                    }
                    continue;
                }
                unreachableTurns = 0;

                // A final answer with no tool call is the model saying it is done.
                // Taking it at its word is better than asking it again and again.
                if (outcome === "answered") {
                    this.stopMission("stopped: the model finished without ending the mission");
                    break;
                }
            }
        } finally {
            this.running = false;
            this.memory.setGoal(DEFAULT_GOAL);
        }
    }
}
