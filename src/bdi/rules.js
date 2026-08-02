/**
 * Returned whenever no rule matches. Every effect has this shape, so a caller
 * multiplies and adds without ever asking which rule answered, or whether one did.
*/
const NO_EFFECT = Object.freeze({ multiplier: 1, additive: 0 });

/**
 * The axes a scoring rule can act on. A mission that needs a fourth one is a
 * change to this file, not to desire generation.
*/
const AXES = Object.freeze(['stack_count', 'delivery_tile', 'parcel_value']);

/**
 * Utility of a temporary goal.
 * Every other utility is a reward over a distance: a parcel is worth tens of points and sits a
 * few tiles away, so ordinary desires land well under a hundred. A thousand puts a mission goal
 * above all of them without having to know anything about the map.
*/
const HOLD_UTILITY = 1000;

/**
 * The key an avoided tile is stored under.
 * Beliefs exports the same helper, but importing it here would close a cycle back onto the
 * module that owns this store, and the expression is one line.
*/
const tileKey = tile => `${tile.x},${tile.y}`;

const isNumber = value => Number.isFinite(value);

/**
 * This function checks a carried count against a stack_count predicate.
 * An absent bound does not constrain, so a predicate with one field tests one thing.
 * @param {{equals?: number, min?: number, max?: number}} predicate
 * @param {number} count
 * @returns {boolean}
*/
function matchesCount(predicate, count) {
    return (predicate.equals === undefined || count === predicate.equals)
        && (predicate.min === undefined || count >= predicate.min)
        && (predicate.max === undefined || count <= predicate.max);
}

/**
 * This function checks a reward against a parcel_value predicate.
 * @param {{minReward?: number, maxReward?: number}} predicate
 * @param {number} reward
 * @returns {boolean}
*/
function matchesReward(predicate, reward) {
    return (predicate.minReward === undefined || reward >= predicate.minReward)
        && (predicate.maxReward === undefined || reward <= predicate.maxReward);
}

/**
 * This function renders a rule the way the model should read it back.
 * @param {{id: string, axis: string, predicate: object, multiplier: number, additive: number}} rule
 * @returns {string}
*/
function describeRule(rule) {
    const effect = [];
    if (rule.multiplier !== 1) effect.push(`multiplied by ${rule.multiplier}`);
    if (rule.additive !== 0) effect.push(`plus ${rule.additive}`);
    const outcome = effect.length > 0 ? effect.join(" and ") : "left as it is";

    switch (rule.axis) {
        case 'stack_count': {
            const bounds = [];
            if (rule.predicate.equals !== undefined) bounds.push(`exactly ${rule.predicate.equals}`);
            if (rule.predicate.min !== undefined) bounds.push(`at least ${rule.predicate.min}`);
            if (rule.predicate.max !== undefined) bounds.push(`at most ${rule.predicate.max}`);
            return `carrying ${bounds.join(" and ")} parcels is worth ${outcome}`;
        }
        case 'delivery_tile':
            return `delivering at (${rule.predicate.x},${rule.predicate.y}) is worth ${outcome}`;
        default: {
            const bounds = [];
            if (rule.predicate.minReward !== undefined) bounds.push(`at least ${rule.predicate.minReward}`);
            if (rule.predicate.maxReward !== undefined) bounds.push(`at most ${rule.predicate.maxReward}`);
            return `a parcel worth ${bounds.join(" and ")} is worth ${outcome}`;
        }
    }
}

/**
 * This function reads a scoring rule out of a plain object and registers it.
 * @param {RuleStore} store
 * @param {*} raw
 * @returns {{ok: true, rule: object, summary: string} | {ok: false, reason: string}}
*/
function applyScoringRule(store, raw) {
    if (typeof raw.id !== 'string' || raw.id.trim() === "") {
        return { ok: false, reason: 'a rule needs an "id" so it can be replaced or lifted later' };
    }
    if (!AXES.includes(raw.axis)) {
        return {
            ok: false,
            reason: `"${raw.axis}" is not an axis. The axes are: ${AXES.join(", ")}`
        };
    }

    const multiplier = raw.multiplier ?? 1;
    const additive = raw.additive ?? 0;
    if (!isNumber(multiplier) || !isNumber(additive)) {
        return { ok: false, reason: '"multiplier" and "additive" have to be numbers' };
    }

    const predicate = {};
    if (raw.axis === 'stack_count') {
        for (const field of ['equals', 'min', 'max']) {
            if (isNumber(raw[field])) predicate[field] = raw[field];
        }
        if (Object.keys(predicate).length === 0) {
            return { ok: false, reason: 'a stack_count rule needs "equals", "min" or "max"' };
        }
    } else if (raw.axis === 'delivery_tile') {
        if (!isNumber(raw.x) || !isNumber(raw.y)) {
            return { ok: false, reason: 'a delivery_tile rule needs "x" and "y"' };
        }
        predicate.x = raw.x;
        predicate.y = raw.y;
    } else {
        for (const field of ['minReward', 'maxReward']) {
            if (isNumber(raw[field])) predicate[field] = raw[field];
        }
        if (Object.keys(predicate).length === 0) {
            return { ok: false, reason: 'a parcel_value rule needs "minReward" or "maxReward"' };
        }
    }

    const rule = {
        id: raw.id.trim(),
        axis: raw.axis,
        predicate,
        multiplier,
        additive,
        registeredAt: Date.now()
    };
    store.upsert(rule);
    return { ok: true, rule, summary: describeRule(rule) };
}

/**
 * This function reads a temporary tile goal out of a plain object and registers it.
 * @param {RuleStore} store
 * @param {*} raw
 * @returns {{ok: true, rule: object, summary: string} | {ok: false, reason: string}}
*/
function applyHoldRule(store, raw) {
    if (typeof raw.id !== 'string' || raw.id.trim() === "") {
        return { ok: false, reason: 'a hold needs an "id"' };
    }
    if (!isNumber(raw.x) || !isNumber(raw.y) || !isNumber(raw.seconds) || raw.seconds <= 0) {
        return { ok: false, reason: 'a hold needs "x", "y" and a positive "seconds"' };
    }

    const rule = {
        id: raw.id.trim(),
        x: raw.x,
        y: raw.y,
        seconds: raw.seconds
    };
    store.injectDesire(rule);
    return {
        ok: true,
        rule,
        summary: `holding at (${rule.x},${rule.y}) for ${rule.seconds} seconds`
    };
}

/**
 * This function validates a rule and registers it, whether it came from a tool of this
 * agent or over the wire from the partner.
 * It is the single door into the store on purpose: two entry points that both built rules
 * would drift apart in silence, and one side would accept a shape the other rejects.
 * A hold is told apart by carrying "seconds"; anything else is read as a scoring rule,
 * so a request with no axis gets the error that lists the axes.
 * @param {RuleStore} store
 * @param {*} raw the rule as written by the model or as received from the partner
 * @returns {{ok: true, rule: object, summary: string} | {ok: false, reason: string}}
*/
export function applyRule(store, raw) {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, reason: 'a rule has to be a JSON object' };
    }
    return isNumber(raw.seconds)
        ? applyHoldRule(store, raw)
        : applyScoringRule(store, raw);
}

/**
 * This class holds the rules a mission has put in force: how rewards are scored, which tiles
 * are out of bounds, and which temporary goal to pursue.
 *
 * It hangs off Beliefs because state belongs where its consumers are, and all three consumers
 * here already receive beliefs and nothing else: desire generation, the pathfinding neighbour
 * test, and intention revision. Threading a store through them would touch every caller for
 * an argument that never varies per caller.
 * The cost is that Beliefs grows a concern that is not sensing, and the honest alternative is
 * a separate store with a facade over the writes. That is the better answer when the consumers
 * are scattered; here there are three and they all already hold beliefs.
 *
 * The three collections below share a lifecycle but nothing else, so each has its own methods.
 * Nothing outside this file reads them: desire generation asks for an effect and never sees an
 * axis or a predicate, which is why a new axis is a change to this file alone.
*/
export class RuleStore {
    constructor() {
        /**
         * Scoring rules by id. Insertion order is meaningful: a rule re-registered goes to the
         * end, and the last match wins, so a later mission overrides an earlier one.
         * @type {Map<string, {id: string, axis: string, predicate: object, multiplier: number, additive: number, registeredAt: number}>}
        */
        this.scoring = new Map();

        /**
         * Tiles that must not be walked through, keyed by position. The position is the whole
         * identity of the ban: forbidding the same tile twice is the same ban, and the lookup
         * runs often enough that it should not be a scan.
         * @type {Map<string, {x: number, y: number}>}
        */
        this.avoided = new Map();

        /**
         * Temporary goals. Unlike the rules above these do expire: "go here and wait" has to end.
         * @type {Map<string, {id: string, target: {x: number, y: number}, utility: number, expiresAt: number}>}
        */
        this.desires = new Map();
    }

    /**
     * This function registers a scoring rule, replacing any rule with the same id.
     * @param {{id: string, axis: string, predicate: object, multiplier: number, additive: number, registeredAt: number}} rule
    */
    upsert(rule) {
        // Deleting first moves the rule to the end of the map. Iteration order is what decides
        // which of several matching rules wins, so re-registering has to count as the newest.
        this.scoring.delete(rule.id);
        this.scoring.set(rule.id, rule);
    }

    /**
     * This function lifts everything registered.
     * It spans the three collections because they share one lifecycle: a mission that is over
     * takes all of its rules with it.
     * @returns {number} how many entries were lifted.
    */
    clear() {
        const lifted = this.scoring.size + this.avoided.size + this.desires.size;
        this.scoring.clear();
        this.avoided.clear();
        this.desires.clear();
        return lifted;
    }

    /**
     * This function returns the effect of the last matching rule on one axis.
     * @param {string} axis
     * @param {function(object): boolean} matches
     * @returns {{multiplier: number, additive: number}} the effect, or the identity when nothing matched.
    */
    effectOn(axis, matches) {
        let effect = NO_EFFECT;
        for (const rule of this.scoring.values()) {
            if (rule.axis === axis && matches(rule.predicate)) {
                effect = { multiplier: rule.multiplier, additive: rule.additive };
            }
        }
        return effect;
    }

    /**
     * @param {number} count how many parcels the agent carries, or would carry
     * @returns {{multiplier: number, additive: number}}
    */
    stackEffect(count) {
        return this.effectOn('stack_count', predicate => matchesCount(predicate, count));
    }

    /**
     * @param {{x: number, y: number}} tile the delivery tile being scored
     * @returns {{multiplier: number, additive: number}}
    */
    deliveryTileEffect(tile) {
        return this.effectOn(
            'delivery_tile',
            predicate => predicate.x === tile.x && predicate.y === tile.y
        );
    }

    /**
     * @param {number} reward a parcel's own reward
     * @returns {{multiplier: number, additive: number}}
    */
    parcelValueEffect(reward) {
        return this.effectOn('parcel_value', predicate => matchesReward(predicate, reward));
    }

    /**
     * This function marks a tile as one to route around.
     * @param {{x: number, y: number}} tile
    */
    avoidTile(tile) {
        this.avoided.set(tileKey(tile), { x: tile.x, y: tile.y });
    }

    /**
     * @returns {boolean} true when at least one tile is avoided.
    */
    get hasAvoided() {
        return this.avoided.size > 0;
    }

    /**
     * This function checks whether a tile must not be walked through.
     * It runs for every neighbour of every expanded tile during a search, so the usual case of
     * no bans at all answers before a key is even built.
     * @param {{x: number, y: number}} tile
     * @returns {boolean}
    */
    isAvoided(tile) {
        if (this.avoided.size === 0) return false;
        return this.avoided.has(tileKey(tile));
    }

    /**
     * This function registers a temporary goal, replacing any goal with the same id.
     * @param {{id: string, x: number, y: number, seconds: number}} hold
    */
    injectDesire(hold) {
        this.desires.set(hold.id, {
            id: hold.id,
            target: { x: hold.x, y: hold.y },
            utility: HOLD_UTILITY,
            expiresAt: Date.now() + hold.seconds * 1000
        });
    }

    /**
     * This function returns the temporary goals still in force, as desires.
     * Expired entries are dropped while reading, the way parcels are forgotten as their reward
     * decays: there is no clock in this codebase other than the cycle that asks.
     * @returns {import("./desires.js").Desire[]}
    */
    injectedDesires() {
        const now = Date.now();
        const active = [];

        for (const [id, entry] of this.desires) {
            if (entry.expiresAt <= now) {
                this.desires.delete(id);
                continue;
            }
            active.push({
                type: 'go_to_tile',
                target: { x: entry.target.x, y: entry.target.y },
                utility: entry.utility
            });
        }

        return active;
    }

    /**
     * This function renders every rule in force for the model to read.
     * Without it the model cannot see what it already registered and would register the same
     * rule again under a new id every turn.
     * @returns {string} the rules, or an empty string when nothing is registered.
    */
    format() {
        const lines = [];
        const now = Date.now();

        for (const rule of this.scoring.values()) {
            lines.push(`- ${rule.id}: ${describeRule(rule)}`);
        }
        for (const tile of this.avoided.values()) {
            lines.push(`- never walk through (${tile.x},${tile.y})`);
        }
        for (const entry of this.desires.values()) {
            const seconds = Math.max(0, Math.round((entry.expiresAt - now) / 1000));
            lines.push(
                `- ${entry.id}: stay at (${entry.target.x},${entry.target.y}) `
                + `for another ${seconds} seconds`
            );
        }

        return lines.length > 0 ? `Rules in force:\n${lines.join("\n")}` : "";
    }
}
