const MAX_PARCELS = 6;
const MAX_DELIVERIES = 6;
const MAX_RECENT_EVENTS = 8;

const point = ({ x, y }) => `(${x},${y})`;

/** @param {import("../bdi/beliefs.js").Beliefs} beliefs */
export function describeState(beliefs) {
    const parcels = beliefs.parcels
        .availableKnown(beliefs.world.localDecayIntervalMs)
        .sort((first, second) => second.reward - first.reward)
        .slice(0, MAX_PARCELS)
        .map(parcel => `${point(parcel)} reward ${parcel.reward}`);
    const deliveries = [...beliefs.world.deliveries.values()]
        .slice(0, MAX_DELIVERIES)
        .map(point);
    const partnerState = beliefs.partner.state;
    const partner = partnerState
        ? `partner: ${point(partnerState)}, carrying ${partnerState.carriedCount} `
            + `parcels, reward ${partnerState.carriedReward}`
        : "partner: unavailable";

    return [
        `position: ${point(beliefs.me.pos)}`,
        `carrying: ${beliefs.parcels.carried.size} parcels, `
            + `reward ${beliefs.parcels.carriedScore()}`,
        partner,
        `parcels: ${parcels.join("; ") || "none"}`,
        `deliveries: ${deliveries.join("; ") || "none"}`,
        `map: ${beliefs.world.width}x${beliefs.world.height}`,
    ].join("\n");
}

export class LLMMemory {
    /** @param {import("../bdi/beliefs.js").Beliefs} beliefs */
    constructor(beliefs) {
        this.beliefs = beliefs;
        this.goal = "";
        this.history = [];
    }

    startMission(goal) {
        this.goal = goal;
        this.history = [];
    }

    finishMission() {
        this.goal = "";
        this.history = [];
    }

    remember(event) {
        this.history.push(String(event));
        if (this.history.length > MAX_RECENT_EVENTS) this.history.shift();
    }

    buildContext() {
        const sections = [
            `Goal: ${this.goal}`,
            `State:\n${describeState(this.beliefs)}`,
            this.beliefs.rules.describeActive(),
        ];
        if (this.history.length) {
            sections.push(`Recent:\n${this.history
                .map(event => `- ${event}`).join("\n")}`);
        }
        return sections.join("\n\n");
    }
}
