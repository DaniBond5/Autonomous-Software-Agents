// Every list handed to the model is truncated. A prompt that grows with the
// game would slow every call down and eventually stop fitting, and the model
// only needs the nearest candidates to decide what to do next.
const MAX_PARCELS = 10;
const MAX_DELIVERIES = 10;
const MAX_RECENT_EVENTS = 5;

// The history is the only list that survives across turns, so it is the only
// one that can grow without bound. This is its ceiling.
const MAX_HISTORY = 100;

const point = ({ x, y }) => `(${x},${y})`;

/**
 * Describes the world in the few lines the model needs to act.
 * It is shared by the context builder and the get_state tool, so the agent
 * always reads the same picture of the game.
 * @param {import("../bdi/beliefs.js").Beliefs} beliefs
 * @returns {string}
 */
export function describeState(beliefs) {
    const parcels = [...beliefs.parcels.visible.values()]
        .filter(parcel => !parcel.carriedBy)
        .slice(0, MAX_PARCELS)
        .map(parcel => `${point(parcel)} reward ${parcel.reward}`);
    const deliveries = [...beliefs.world.deliveries.values()]
        .slice(0, MAX_DELIVERIES)
        .map(point);

    return [
        `position: ${point(beliefs.me.pos)}`,
        `score: ${beliefs.me.score}`,
        `carrying: ${beliefs.parcels.carried.size} parcels `
        + `worth ${beliefs.parcels.carriedScore()}`,
        `parcels on the ground: ${parcels.join(", ") || "none in sight"}`,
        `delivery tiles: ${deliveries.join(", ") || "none known"}`,
        `map size: ${beliefs.world.width} by ${beliefs.world.height}, `
        + `so x goes from 0 to ${beliefs.world.width - 1} `
        + `and y from 0 to ${beliefs.world.height - 1}`,
    ].join("\n");
}

/**
 * The working memory of the LLM agent: current goal, world snapshot and the
 * events of the recent past. It is rebuilt into a prompt on every turn rather
 * than accumulated, so the context stays the same size all game long.
 */
export class LLMMemory {
    /**
     * @param {import("../bdi/beliefs.js").Beliefs} beliefs
     */
    constructor(beliefs) {
        this.beliefs = beliefs;

        /** @type {string} */
        this.goal = "";

        /** @type {string[]} */
        this.history = [];

        /**
         * What the replanner watches: the last observed world, kept to tell a real change
         * from noise, and the two events that happen rather than persist. Each field is read
         * and cleared by its own reader below, so one event replans once.
         */
        this.snapshot = {
            carried: beliefs.parcels.carried.size,
            failedTool: null,
            goalReplaced: false,
        };
    }

    /**
     * @param {string} goal the goal in natural language
     */
    setGoal(goal) {
        this.goal = goal;
        this.remember(`new goal: ${goal}`);
    }

    /**
     * Records a tool that failed for a reason it did not choose: it threw, or there is no
     * such tool. A tool that returns a message explaining why it could not do something has
     * done its job, and marking those would replan on almost every turn.
     * @param {string} name
     */
    noteToolFailure(name) {
        this.snapshot.failedTool = name;
    }

    /**
     * Records that a goal arrived while another was being worked on.
     * Only that case counts. Setting a goal with nothing running is the start of a mission,
     * and there is no plan yet to reconsider; the end of every mission sets the default goal
     * too, and marking that would make the next mission replan on its first turn for the rest
     * of the game.
     */
    noteGoalReplaced() {
        this.snapshot.goalReplaced = true;
    }

    /**
     * Drops the changes still waiting to be reported, and takes the world as it stands now.
     *
     * These fields describe what happened inside one mission, so they end with it. A trigger
     * raised during the last turn has no next turn to be read in: the check that would have
     * read it runs at the start of a turn, and tools run during one. Carried across, it would
     * open the following mission by asking the model to reconsider an approach belonging to
     * work that is already over.
     */
    forgetPendingChanges() {
        this.snapshot.failedTool = null;
        this.snapshot.goalReplaced = false;
        this.snapshot.carried = this.beliefs.parcels.carried.size;
    }

    /**
     * Adds one line to the history, dropping the oldest when it is full.
     * @param {string} event
     */
    remember(event) {
        this.history.push(event);
        if (this.history.length > MAX_HISTORY) {
            this.history.splice(0, this.history.length - MAX_HISTORY);
        }
    }

    /**
     * Builds the compact state description sent to the model each turn.
     * @returns {string}
     */
    buildContext() {
        const recent = this.history.slice(-MAX_RECENT_EVENTS);
        // The rules go in beside the state because they are part of it: without reading them
        // back the model cannot tell a rule it already registered from one it still has to,
        // and would register the same thing again under a new id every turn.
        const rules = this.beliefs.rules.format();
        return [
            `Goal: ${this.goal}`,
            "",
            "Current state:",
            describeState(this.beliefs),
            ...(rules ? ["", rules] : []),
            "",
            "What happened recently:",
            recent.map(event => `- ${event}`).join("\n") || "- nothing yet",
        ].join("\n");
    }

    /**
     * Whether the world moved enough to be worth a new plan.
     * The test is deliberately narrow: a sensitive one would replan on every
     * parcel that decays a point and hammer the model with calls. Carrying a
     * different number of parcels is the change that actually invalidates a
     * plan built around picking up or delivering.
     * The snapshot is refreshed here, so a change is reported once.
     * @returns {boolean}
     */
    hasWorldChanged() {
        const carried = this.beliefs.parcels.carried.size;
        if (carried === this.snapshot.carried) return false;
        this.snapshot.carried = carried;
        return true;
    }

    /**
     * Which tool failed since this was last asked, if one did.
     * Cleared here, like the check above, so one failure is reported once.
     * @returns {string | null} the tool's name, or null when none failed
     */
    hasToolFailed() {
        const failedTool = this.snapshot.failedTool;
        this.snapshot.failedTool = null;
        return failedTool;
    }

    /**
     * Whether a new goal replaced the one being worked on since this was last asked.
     * Cleared here, like the checks above, so one replacement is reported once.
     * @returns {boolean}
     */
    hasGoalChanged() {
        const goalReplaced = this.snapshot.goalReplaced;
        this.snapshot.goalReplaced = false;
        return goalReplaced;
    }
}
