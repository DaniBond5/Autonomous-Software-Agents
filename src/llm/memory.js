// Every list handed to the model is truncated. A prompt that grows with the
// game would slow every call down and eventually stop fitting, and the model
// needs the best few candidates to decide what to do next, not all of them.
const MAX_PARCELS = 10;
const MAX_DELIVERIES = 10;

// A mission can run for ten turns, so five lines of history let it forget what
// it did at the start and repeat it. Fifteen covers a whole mission at three
// tool calls a turn, and the prompt is rebuilt from scratch against an endpoint
// the whole course shares, so it does not pay to carry much more than that.
const MAX_RECENT_EVENTS = 15;

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
    // The known set, not the visible one: it holds what this agent can see and also what the
    // partner reported, which is the half of the memory the brief asks to come from exchanging
    // beliefs. This accessor is the one that re-estimates a reward from when it was observed
    // and forgets a parcel once that reaches zero, so nothing stale reaches the prompt.
    // Sorted by reward before truncating, because the ten the model is told about should be
    // the ten worth telling it about rather than the ten observed longest ago.
    const parcels = beliefs.parcels
        .availableKnown(beliefs.world.localDecayIntervalMs)
        .sort((first, second) => second.reward - first.reward)
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

        /** What the replanner watches between turns of one mission. */
        this.snapshot = {
            carried: beliefs.parcels.carried.size,
            failedTool: null,
        };
    }

    /**
     * Opens fresh working memory for one mission.
     * @param {string} goal the mission in natural language
     */
    startMission(goal) {
        this.goal = goal;
        this.history = [];
        this._resetMissionEvents();
        this.remember(`new goal: ${goal}`);
    }

    /** Clears mission text and transient events while preserving game state. */
    finishMission() {
        this.goal = "";
        this.history = [];
        this._resetMissionEvents();
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

    /** Drops pending events and takes the current carried count as the baseline. */
    _resetMissionEvents() {
        this.snapshot.failedTool = null;
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
}
