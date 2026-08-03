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

const point = ({ x, y }) => `(${x},${y})`;

/**
 * Describes the world in the few lines the model needs to act.
 * It is rebuilt by the context builder, so every model turn reads the current
 * picture of the game.
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
    let partner = "partner: not configured";
    if (beliefs.partner.isKnown) {
        if (!beliefs.partner.state) {
            partner = "partner: known, no state received yet";
        } else {
            const state = beliefs.partner.state;
            partner = `partner last report: position ${point(state)}, carrying `
                + `${state.carriedCount} parcels worth ${state.carriedReward}`;
        }
    }

    return [
        `position: ${point(beliefs.me.pos)}`,
        `score: ${beliefs.me.score}`,
        `carrying: ${beliefs.parcels.carried.size} parcels `
        + `worth ${beliefs.parcels.carriedScore()}`,
        partner,
        `parcels on the ground: ${parcels.join(", ") || "none in sight"}`,
        `delivery tiles: ${deliveries.join(", ") || "none known"}`,
        `map size: ${beliefs.world.width} by ${beliefs.world.height}, `
        + `so x goes from 0 to ${beliefs.world.width - 1} `
        + `and y from 0 to ${beliefs.world.height - 1}`,
    ].join("\n");
}

/**
 * The working memory of the LLM agent: current goal, recent events and one
 * pending replan reason. It is rebuilt into a prompt on every turn rather
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

        /** @type {string | null} */
        this.pendingReplanReason = null;
    }

    /**
     * Opens fresh working memory for one mission.
     * @param {string} goal the mission in natural language
     */
    startMission(goal) {
        this.goal = goal;
        this.history = [];
        this.pendingReplanReason = null;
        this.remember(`new goal: ${goal}`);
    }

    /** Clears mission text and transient events while preserving game state. */
    finishMission() {
        this.goal = "";
        this.history = [];
        this.pendingReplanReason = null;
    }

    /**
     * Stores the first valid semantic failure that has not been handled yet.
     * @param {string} reason
     */
    requestReplan(reason) {
        if (typeof reason !== "string" || !reason.trim()) return;
        if (this.pendingReplanReason === null) {
            this.pendingReplanReason = reason.trim();
        }
    }

    /**
     * Returns one pending reason and removes it from memory.
     * @returns {string | null}
     */
    takeReplanReason() {
        const reason = this.pendingReplanReason;
        this.pendingReplanReason = null;
        return reason;
    }

    /**
     * Adds one line to the history, dropping the oldest when it is full.
     * @param {string} event
     */
    remember(event) {
        this.history.push(event);
        if (this.history.length > MAX_RECENT_EVENTS) {
            this.history.splice(0, this.history.length - MAX_RECENT_EVENTS);
        }
    }

    /**
     * Builds the compact state description sent to the model each turn.
     * @returns {string}
     */
    buildContext() {
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
            this.history.map(event => `- ${event}`).join("\n") || "- nothing yet",
        ].join("\n");
    }
}
