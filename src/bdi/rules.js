/** Utility of the one temporary hold goal. */
const HOLD_UTILITY = 1000;

const COMPARISONS = new Set([
    "above",
    "below",
    "at_least",
    "at_most"
]);

const tileKey = tile => `${tile.x},${tile.y}`;
const isObject = value => value !== null
    && typeof value === "object"
    && !Array.isArray(value);
const isNonNegativeNumber = value => Number.isFinite(value) && value >= 0;

export class RuleStore {
    constructor() {
        /** @type {{count:number,multiplier:number}|null} */
        this.stackPolicy = null;

        /** @type {{tiles:{x:number,y:number}[],multiplier:number}|null} */
        this.deliveryPolicy = null;

        /** @type {{comparison:string,value:number,multiplier:number}|null} */
        this.parcelValuePolicy = null;

        /** @type {Map<string,{x:number,y:number}>} */
        this.avoided = new Map();

        /** @type {{id:string,target:{x:number,y:number},utility:number,expiresAt:number}|null} */
        this.hold = null;
    }

    apply(raw) {
        if (!isObject(raw)) {
            return { ok: false, text: "strategy input must be a JSON object" };
        }

        switch (raw.type) {
            case "set_stack": {
                if (!Number.isInteger(raw.count) || raw.count <= 0) {
                    return { ok: false, text: "stack count must be a positive integer" };
                }
                if (!isNonNegativeNumber(raw.multiplier)) {
                    return { ok: false, text: "stack multiplier must be non-negative" };
                }
                const operation = {
                    type: "set_stack",
                    count: raw.count,
                    multiplier: raw.multiplier
                };
                this.stackPolicy = {
                    count: operation.count,
                    multiplier: operation.multiplier
                };
                return {
                    ok: true,
                    operation,
                    text: `Stack strategy set: deliver exactly ${operation.count} parcels `
                        + `with multiplier ${operation.multiplier}.`
                };
            }
            case "set_delivery": {
                if (!Array.isArray(raw.tiles) || raw.tiles.length === 0) {
                    return { ok: false, text: "delivery tiles must be a non-empty array" };
                }
                if (!isNonNegativeNumber(raw.multiplier)) {
                    return { ok: false, text: "delivery multiplier must be non-negative" };
                }
                const tiles = [];
                const seen = new Set();
                for (const tile of raw.tiles) {
                    if (!Number.isInteger(tile?.x) || !Number.isInteger(tile?.y)) {
                        return { ok: false, text: "every delivery tile needs integer x and y" };
                    }
                    const key = tileKey(tile);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    tiles.push({ x: tile.x, y: tile.y });
                }
                const operation = {
                    type: "set_delivery",
                    tiles,
                    multiplier: raw.multiplier
                };
                this.deliveryPolicy = {
                    tiles: operation.tiles.map(tile => ({ ...tile })),
                    multiplier: operation.multiplier
                };
                return {
                    ok: true,
                    operation,
                    text: `Delivery strategy set: ${tiles
                        .map(tile => `(${tile.x},${tile.y})`).join(", ")}, `
                        + `multiplier ${operation.multiplier}.`
                };
            }
            case "set_parcel_value": {
                if (!COMPARISONS.has(raw.comparison)) {
                    return {
                        ok: false,
                        text: "parcel comparison must be above, below, at_least, or at_most"
                    };
                }
                if (!isNonNegativeNumber(raw.value)) {
                    return { ok: false, text: "parcel value must be non-negative" };
                }
                if (!isNonNegativeNumber(raw.multiplier)) {
                    return { ok: false, text: "parcel multiplier must be non-negative" };
                }
                const operation = {
                    type: "set_parcel_value",
                    comparison: raw.comparison,
                    value: raw.value,
                    multiplier: raw.multiplier
                };
                this.parcelValuePolicy = {
                    comparison: operation.comparison,
                    value: operation.value,
                    multiplier: operation.multiplier
                };
                return {
                    ok: true,
                    operation,
                    text: `Parcel value strategy set: ${operation.comparison} `
                        + `${operation.value}, multiplier ${operation.multiplier}.`
                };
            }
            case "avoid_tile": {
                if (!Number.isInteger(raw.x) || !Number.isInteger(raw.y)) {
                    return { ok: false, text: "an avoided tile needs integer x and y" };
                }
                const operation = { type: "avoid_tile", x: raw.x, y: raw.y };
                this.avoided.set(tileKey(operation), { x: operation.x, y: operation.y });
                return {
                    ok: true,
                    operation,
                    text: `Tile (${operation.x},${operation.y}) will be avoided.`
                };
            }
            case "clear": {
                if (Object.keys(raw).some(field => field !== "type")) {
                    return { ok: false, text: "clear does not take strategy fields" };
                }
                this.stackPolicy = null;
                this.deliveryPolicy = null;
                this.parcelValuePolicy = null;
                this.avoided.clear();
                return {
                    ok: true,
                    operation: { type: "clear" },
                    text: "Level 2 strategies cleared."
                };
            }
            default:
                return { ok: false, text: "unknown strategy type" };
        }
    }

    /** @returns {number|null} */
    stackTarget() {
        return this.stackPolicy?.count ?? null;
    }

    /**
     * A pickup collects every parcel on the tile.
     * The projected count must include the full batch.
     */
    canPickUpBatch(currentCount, batchCount) {
        const target = this.stackTarget();
        if (target === null) return true;
        if (!Number.isInteger(currentCount)
            || !Number.isInteger(batchCount)
            || batchCount <= 0
            || currentCount >= target) return false;
        return currentCount + batchCount <= target;
    }

    canDeliverStack(currentCount) {
        const target = this.stackTarget();
        return target === null || currentCount >= target;
    }

    stackMultiplier(currentCount) {
        if (!this.stackPolicy || currentCount !== this.stackPolicy.count) {
            // Delivery is allowed above the target only as a recovery path.
            // The exact-stack bonus is not applied in this case.
            return 1;
        }
        return this.stackPolicy.multiplier;
    }

    deliveryMultiplier(tile) {
        return this.includesDeliveryTile(tile)
            ? this.deliveryPolicy.multiplier
            : 1;
    }

    includesDeliveryTile(tile) {
        if (!this.deliveryPolicy
            || !Number.isInteger(tile?.x)
            || !Number.isInteger(tile?.y)) return false;
        return this.deliveryPolicy.tiles.some(candidate =>
            candidate.x === tile.x && candidate.y === tile.y
        );
    }

    parcelMultiplier(reward) {
        const policy = this.parcelValuePolicy;
        if (!policy) return 1;

        let matches = false;
        switch (policy.comparison) {
            case "above": matches = reward > policy.value; break;
            case "below": matches = reward < policy.value; break;
            case "at_least": matches = reward >= policy.value; break;
            case "at_most": matches = reward <= policy.value; break;
        }
        return matches ? policy.multiplier : 1;
    }

    isAvoided(tile) {
        return this.avoided.has(tileKey(tile));
    }

    /** Validates and replaces the one temporary hold. */
    setHold(raw) {
        if (!isObject(raw)
            || typeof raw.id !== "string"
            || raw.id.trim() === ""
            || !Number.isInteger(raw.x)
            || !Number.isInteger(raw.y)
            || !Number.isFinite(raw.seconds)
            || raw.seconds <= 0) {
            return { ok: false, reason: "a hold needs integer x and y and positive seconds" };
        }

        this.hold = {
            id: raw.id.trim(),
            target: { x: raw.x, y: raw.y },
            utility: HOLD_UTILITY,
            expiresAt: Date.now() + raw.seconds * 1000
        };
        return {
            ok: true,
            summary: `holding at (${raw.x},${raw.y}) for ${raw.seconds} seconds`
        };
    }

    /** Returns the active hold, removing it when it has expired. */
    activeHold() {
        if (this.hold && this.hold.expiresAt <= Date.now()) this.hold = null;
        return this.hold;
    }

    /** Clears only the active hold with the given id. */
    clearHold(id) {
        const hold = this.activeHold();
        if (!hold || hold.id !== id) return false;
        this.hold = null;
        return true;
    }

    /** @returns {import("./desires.js").Desire[]} */
    injectedDesires() {
        const hold = this.activeHold();
        if (!hold) return [];
        return [{
            type: "go_to_tile",
            target: { ...hold.target },
            utility: hold.utility
        }];
    }

    describeActive() {
        const lines = [];
        if (this.stackPolicy) {
            lines.push(
                `- stack: ${this.stackPolicy.count} parcels, `
                + `multiplier ${this.stackPolicy.multiplier}`
            );
        }
        if (this.deliveryPolicy) {
            const tiles = this.deliveryPolicy.tiles
                .map(tile => `(${tile.x},${tile.y})`)
                .join(", ");
            lines.push(`- delivery: ${tiles}, multiplier ${this.deliveryPolicy.multiplier}`);
        }
        if (this.parcelValuePolicy) {
            lines.push(
                `- parcel value: ${this.parcelValuePolicy.comparison} `
                + `${this.parcelValuePolicy.value}, multiplier `
                + this.parcelValuePolicy.multiplier
            );
        }
        if (this.avoided.size > 0) {
            const tiles = [...this.avoided.values()]
                .map(tile => `(${tile.x},${tile.y})`)
                .join(", ");
            lines.push(`- avoid: ${tiles}`);
        }

        const sections = [lines.length > 0
            ? `strategy:\n${lines.join("\n")}`
            : "strategy: none"];
        const hold = this.activeHold();
        if (hold) {
            const seconds = Math.max(0, Math.round((hold.expiresAt - Date.now()) / 1000));
            sections.push(
                `hold:\n- (${hold.target.x},${hold.target.y}), `
                + `${seconds} seconds remaining`
            );
        }
        return sections.join("\n\n");
    }
}
