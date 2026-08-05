import config from "../config.js";
import { preferOperationalDeliveryCandidates } from "../bdi/desires.js";
import {
    distanceFromSearch,
    isMoveAllowed,
    isPositionTraversable,
    shortestPathsFrom
} from "../utils/geometry.js";
import { trace } from "../utils/trace.js";

const dbg = (...args) => {
    if (config.debug) console.log("[llm]", ...args);
};

/** @typedef {{ok: boolean, text: string}} ToolExecutionResult */

const success = text => ({ ok: true, text });
const failure = text => ({ ok: false, text });

const COORDINATION_POLL_MS = 100;

// Walking is only part of a handoff: planning, sensing ticks and the partner's
// own loop all cost wall time that does not scale with movementDurationMs. An
// observed run walked 12 tiles in about 3 s where a move was nominally 50 ms,
// roughly 5x per move; estimatedMoves sums both agents even though they move in
// parallel, which absorbs about half of that, so 3x covers the gap. The floor
// carries short exchanges, whose cost is almost entirely coordination: at 50 ms
// a move the previous additive map-size slack was worth under a second.
const HANDOFF_TIMEOUT_MARGIN = 3;
const HANDOFF_MIN_TIMEOUT_MS = 10_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Only digits, spaces, parentheses and the four operators are ever parsed. */
const ARITHMETIC = /^[\d+\-*/()\s]+$/;

const isObject = value => value !== null
    && typeof value === "object"
    && !Array.isArray(value);
const isIntegerPosition = position =>
    Number.isInteger(position?.x) && Number.isInteger(position?.y);
const manhattanDistance = (first, second) =>
    Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
const samePosition = (first, second) =>
    first?.x === second?.x && first?.y === second?.y;
const copyPoint = point => ({ x: point.x, y: point.y });
const tileKey = tile => `${tile.x},${tile.y}`;
const compareTiles = (first, second) =>
    first.x - second.x || first.y - second.y;
const compareStrings = (first, second) =>
    first < second ? -1 : first > second ? 1 : 0;
const CARDINAL_STEPS = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
];

function freeKnownParcels(beliefs) {
    const byId = new Map();
    const reported = [
        ...beliefs.parcels.known.values(),
        ...beliefs.parcels.visible.values(),
    ];
    for (const parcel of reported) {
        if (typeof parcel?.id !== "string" || !parcel.id.trim()
            || !isIntegerPosition(parcel) || parcel.carriedBy) continue;
        byId.set(parcel.id.trim(), { ...parcel, id: parcel.id.trim() });
    }
    return [...byId.values()];
}

const adjacentTiles = (beliefs, center) => CARDINAL_STEPS
    .map(step => beliefs.world.tiles.get(tileKey({
        x: center.x + step.x,
        y: center.y + step.y,
    })))
    .filter(isIntegerPosition)
    .map(copyPoint);

/** Parcels already held by one of the two agents, deduplicated by parcel id. */
function carriedHandoffCandidates(beliefs) {
    const byId = new Map();
    const addCarried = (parcelId, giverId, receiverId, carrier) => {
        const id = typeof parcelId === "string" ? parcelId.trim() : "";
        if (!id || byId.has(id) || !isIntegerPosition(carrier)) return;
        byId.set(id, {
            // A carried parcel is not sensed, so describe it from its carrier.
            parcel: { id, x: carrier.x, y: carrier.y },
            parcelStart: copyPoint(carrier),
            giverId,
            receiverId,
            giverStartPhase: "drop",
            carried: true,
        });
    };

    for (const parcelId of beliefs.parcels.carried.keys()) {
        addCarried(parcelId, beliefs.me.id, beliefs.partner.id, beliefs.me.pos);
    }
    for (const parcelId of beliefs.partner.state?.carriedParcelIds ?? []) {
        addCarried(
            parcelId, beliefs.partner.id, beliefs.me.id, beliefs.partner.state
        );
    }
    return [...byId.values()];
}

/** Both assignments are offered, because either agent can fetch a free parcel. */
function freeHandoffCandidates(beliefs, freeParcels) {
    return freeParcels.flatMap(parcel => {
        const shared = {
            parcel: { id: parcel.id, x: parcel.x, y: parcel.y },
            parcelStart: copyPoint(parcel),
            giverStartPhase: "pickup",
            carried: false,
        };
        return [
            { ...shared, giverId: beliefs.me.id, receiverId: beliefs.partner.id },
            { ...shared, giverId: beliefs.partner.id, receiverId: beliefs.me.id },
        ];
    });
}

// Cached per handoff tile: candidates sharing one drop tile share this search.
function bestDeliveryFrom(beliefs, handoffTile, pathOptions, cache) {
    const key = tileKey(handoffTile);
    if (cache.has(key)) return cache.get(key);

    const handoffPaths = shortestPathsFrom(beliefs, handoffTile, pathOptions);
    const deliveries = [...beliefs.world.deliveries.values()]
        .map(delivery => ({
            delivery,
            distance: distanceFromSearch(handoffPaths, delivery),
        }))
        .filter(candidate => !beliefs.rules.isAvoided(candidate.delivery)
            && Number.isFinite(candidate.distance));
    const selected = preferOperationalDeliveryCandidates(beliefs, deliveries)
        .sort((first, second) =>
            first.distance - second.distance
            || compareTiles(first.delivery, second.delivery)
        )[0] ?? null;

    cache.set(key, selected);
    return selected;
}

// A carried parcel skips the pickup entirely, so it always wins over a free one.
const compareHandoffConfigurations = (first, second) =>
    Number(second.carried) - Number(first.carried)
    || first.estimatedMoves - second.estimatedMoves
    || compareStrings(first.parcel.id, second.parcel.id)
    || compareStrings(first.giverId, second.giverId)
    || compareTiles(first.handoffTile, second.handoffTile)
    || compareTiles(first.waitTile, second.waitTile)
    || compareTiles(first.exitTile, second.exitTile);

function selectHandoffConfiguration(beliefs) {
    const pathOptions = { isBlocked: position => beliefs.crates.isOccupied(position) };
    const pathsById = new Map([
        [beliefs.me.id, beliefs.me.pos],
        [beliefs.partner.id, beliefs.partner.state],
    ].map(([id, origin]) =>
        [id, shortestPathsFrom(beliefs, origin, pathOptions)]
    ));

    const carriedCandidates = carriedHandoffCandidates(beliefs);
    const carriedIds = new Set(
        carriedCandidates.map(candidate => candidate.parcel.id)
    );
    // A parcel picked up outside sensing keeps a stale free position in beliefs,
    // so a carried id must never reappear as a free parcel or as a busy tile.
    const freeParcels = freeKnownParcels(beliefs)
        .filter(parcel => !carriedIds.has(parcel.id));
    const occupiedByFreeParcel = new Set(freeParcels.map(tileKey));
    const deliveryCache = new Map();
    const configurations = [];

    for (const candidate of [
        ...carriedCandidates,
        ...freeHandoffCandidates(beliefs, freeParcels),
    ]) {
        const giverPaths = pathsById.get(candidate.giverId);
        const receiverPaths = pathsById.get(candidate.receiverId);
        const parcelStart = candidate.parcelStart;
        if (!giverPaths || !receiverPaths
            || !isPositionTraversable(beliefs, parcelStart)
            || beliefs.world.deliveries.has(tileKey(parcelStart))
            || beliefs.rules.isAvoided(parcelStart)) continue;

        const giverPickupDistance = distanceFromSearch(giverPaths, parcelStart);
        if (candidate.giverStartPhase === "pickup"
            && !Number.isFinite(giverPickupDistance)) continue;

        const handoffTiles = adjacentTiles(beliefs, parcelStart)
            .filter(tile => isPositionTraversable(beliefs, tile)
                && isMoveAllowed(beliefs, parcelStart, tile)
                && !beliefs.world.deliveries.has(tileKey(tile))
                && !beliefs.world.spawners.has(tileKey(tile))
                && !beliefs.world.isCrateSpace(tile)
                && !beliefs.crates.isOccupied(tile)
                && !beliefs.rules.isAvoided(tile)
                && !occupiedByFreeParcel.has(tileKey(tile)))
            .sort(compareTiles);

        for (const handoffTile of handoffTiles) {
            // A giver already carrying the parcel walks straight to the drop.
            const giverApproach = candidate.giverStartPhase === "drop"
                ? distanceFromSearch(giverPaths, handoffTile)
                : giverPickupDistance + 1;
            if (!Number.isFinite(giverApproach)) continue;

            const neighbors = adjacentTiles(beliefs, handoffTile)
                .filter(tile => isPositionTraversable(beliefs, tile)
                    && !beliefs.crates.isOccupied(tile)
                    && !beliefs.rules.isAvoided(tile))
                .sort(compareTiles);
            const wait = neighbors
                .map(tile => ({
                    tile,
                    distance: distanceFromSearch(receiverPaths, tile),
                }))
                .filter(entry => !samePosition(entry.tile, parcelStart)
                    && Number.isFinite(entry.distance)
                    && isMoveAllowed(beliefs, entry.tile, handoffTile))
                .sort((first, second) =>
                    first.distance - second.distance
                    || compareTiles(first.tile, second.tile)
                )[0];
            if (!wait) continue;

            const exitTile = neighbors
                .filter(tile => !samePosition(tile, wait.tile)
                    && isMoveAllowed(beliefs, handoffTile, tile))
                .sort(compareTiles)[0];
            if (!exitTile) continue;

            const selectedDelivery = bestDeliveryFrom(
                beliefs, handoffTile, pathOptions, deliveryCache
            );
            if (!selectedDelivery) continue;

            // The receiver reaches its wait tile, steps onto the handoff tile
            // to pick the parcel up, and only then walks to the delivery.
            const receiverMoves = wait.distance
                + 1
                + selectedDelivery.distance;

            configurations.push({
                giverId: candidate.giverId,
                receiverId: candidate.receiverId,
                giverStartPhase: candidate.giverStartPhase,
                receiverStartPhase: "wait",
                carried: candidate.carried,
                parcel: { ...candidate.parcel },
                parcelStart: copyPoint(parcelStart),
                handoffTile: copyPoint(handoffTile),
                waitTile: copyPoint(wait.tile),
                exitTile: copyPoint(exitTile),
                deliveryTile: copyPoint(selectedDelivery.delivery),
                estimatedMoves: giverApproach + receiverMoves + 4,
            });
        }
    }

    return configurations.sort(compareHandoffConfigurations)[0] ?? null;
}

function selectRendezvousTargets(beliefs, center, radius) {
    const candidates = [...beliefs.world.tiles.values()]
        .filter(tile => isIntegerPosition(tile)
            && manhattanDistance(tile, center) <= radius
            && isPositionTraversable(beliefs, tile)
            && !beliefs.rules.isAvoided(tile))
        .map(copyPoint);
    const isBlocked = position => beliefs.crates.isOccupied(position);
    const myPaths = shortestPathsFrom(beliefs, beliefs.me.pos, {
        isBlocked
    });
    const partnerPaths = shortestPathsFrom(beliefs, beliefs.partner.state, {
        isBlocked
    });
    const reachableFrom = search => candidates
        .map(tile => ({
            tile,
            distance: distanceFromSearch(search, tile)
        }))
        .filter(candidate => Number.isFinite(candidate.distance))
        .sort((first, second) =>
            first.distance - second.distance
            || compareTiles(first.tile, second.tile)
        );
    const myCandidates = reachableFrom(myPaths);
    const partnerCandidates = reachableFrom(partnerPaths);

    for (const mine of myCandidates) {
        const theirs = partnerCandidates.find(candidate =>
            !samePosition(candidate.tile, mine.tile)
        );
        if (theirs) {
            return {
                myTarget: mine.tile,
                partnerTarget: theirs.tile,
                myDistance: mine.distance,
                partnerDistance: theirs.distance
            };
        }
    }

    return null;
}

// Parse only arithmetic tokens; never execute arbitrary calculator input.
function evaluateExpression(expression) {
    if (typeof expression !== "string" || !ARITHMETIC.test(expression)) return null;

    const tokens = expression.match(/\d+|[+\-*/()]/g) ?? [];
    let next = 0;

    const readSum = () => {
        let value = readProduct();
        while (tokens[next] === "+" || tokens[next] === "-") {
            value = tokens[next++] === "+" ? value + readProduct() : value - readProduct();
        }
        return value;
    };
    const readProduct = () => {
        let value = readValue();
        while (tokens[next] === "*" || tokens[next] === "/") {
            value = tokens[next++] === "*" ? value * readValue() : value / readValue();
        }
        return value;
    };
    const readValue = () => {
        if (tokens[next] === "-") {
            next += 1;
            return -readValue();
        }
        if (tokens[next] === "(") {
            next += 1;
            const value = readSum();
            if (tokens[next++] !== ")") throw new Error("unbalanced parentheses");
            return value;
        }
        const token = tokens[next++];
        if (!/^\d+$/.test(token ?? "")) throw new Error("expected a number");
        return Number(token);
    };

    try {
        const value = readSum();
        if (next !== tokens.length) return null;
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/** @returns {{x:number,y:number} | null} */
function parseTile(input) {
    const numbers = String(input ?? "").match(/-?\d+/g);
    if (!numbers || numbers.length < 2) return null;
    return { x: Number(numbers[0]), y: Number(numbers[1]) };
}

// Tool descriptions also feed the system prompt below.
export class LLMExecutor {
    /**
     * @param {{beliefs: import("../bdi/beliefs.js").Beliefs,
     *          socket: object,
     *          objectives: import("../bdi/objectives.js").ObjectiveStore}} parts
     */
    constructor({ beliefs, socket, objectives }) {
        this.beliefs = beliefs;
        this.socket = socket;
        this.objectives = objectives;

        this.tools = {
            go_to: {
                description: "Walk to a tile. Input is the pair of coordinates, "
                    + "for example 4,7. Returns when you arrive or when the tile "
                    + "cannot be reached.",
                run: input => this.goTo(input),
            },
            pick_up: {
                description: "Pick up the parcels lying on the tile you are "
                    + "standing on. Walk there first.",
                run: () => this.pickUp(),
            },
            put_down: {
                description: "Drop the parcels you carry on the tile you are "
                    + "standing on. On a delivery tile they are scored.",
                run: () => this.putDown(),
            },
            calculate: {
                description: "Work out an arithmetic expression, for example "
                    + "4*2+1. Use it whenever a mission gives a coordinate as a "
                    + "sum or a product instead of a number.",
                run: async input => {
                    const expression = typeof input === "string" ? input : "";
                    const value = evaluateExpression(expression);
                    return value === null
                        ? failure(
                            `Cannot compute "${expression}": only numbers, + - * / and parentheses are allowed.`
                        )
                        : success(`${expression} = ${value}`);
                },
            },
            set_strategy: {
                description: "Set one Level 2 strategy that remains active after the mission "
                    + "for this agent and its configured teammate. Input is one JSON object "
                    + "in one of these forms: "
                    + '{"type":"set_stack","count":3,"multiplier":2}; '
                    + '{"type":"set_delivery","tiles":[{"x":4,"y":7}],"multiplier":5}; '
                    + '{"type":"set_parcel_value","comparison":"above","value":10,'
                    + '"multiplier":0}; {"type":"avoid_tile","x":3,"y":6}; '
                    + '{"type":"clear"}.',
                run: input => this.applyStrategy(input),
            },
            rendezvous: {
                description: "Move both agents near one position and wait for both to arrive. "
                    + "Input is JSON with integer x, y, and a non-negative Manhattan radius, "
                    + 'for example {"x":4,"y":7,"radius":3}.',
                run: input => this.rendezvous(input),
            },
            handoff_parcel: {
                description: "Transfer one parcel from one agent to the other so that it "
                    + "gets delivered. Input must be {}. The runtime picks a free or already "
                    + "carried parcel, decides which agent gives it and which one receives "
                    + "it, selects the safe exchange tiles, then waits for the receiver to "
                    + "deliver that same parcel.",
                run: input => this.handoffParcel(input),
            },
        };
    }

    /** @returns {boolean} */
    cancelPendingObjective(reason) {
        return this.objectives.cancelActive(reason);
    }

    /** @returns {Promise<string>} */
    async replyTo(senderId, message) {
        if (typeof senderId !== "string" || !senderId.trim()) {
            throw new TypeError("mission sender must be a non-empty string");
        }
        if (typeof message !== "string" || !message.trim()) {
            throw new TypeError("mission reply must be a non-empty string");
        }

        const status = await this.socket.emitSay(senderId, message.trim());
        return `message sent (${status})`;
    }

    // Unexpected tool errors are logged here but hidden from the model.
    /** @returns {Promise<ToolExecutionResult>} */
    async run(name, input) {
        const toolName = typeof name === "string" ? name.trim() : "";
        const shownName = toolName || "(empty)";
        trace("tool", "start", {
            name: shownName,
            input: input ?? ""
        });

        let result;
        if (!toolName || !Object.hasOwn(this.tools, toolName)) {
            result = failure(
                `Unknown tool: ${shownName}. Available tools: ${Object.keys(this.tools).join(", ")}.`
            );
        } else {
            dbg(`${toolName}(${input ?? ""})`);
            try {
                result = await this.tools[toolName].run(input);
            } catch (error) {
                console.error(`[llm] ${toolName} tool failed unexpectedly:`, error);
                result = failure("The tool failed because of an internal error.");
            }
        }

        trace("tool", "finish", {
            name: shownName,
            ok: result?.ok === true,
            text: result?.text ?? ""
        });
        return result;
    }

    /**
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async goTo(input) {
        const target = parseTile(input);
        if (!target) {
            return failure(
                `Cannot read "${input}" as a tile. Write it as x,y.`
            );
        }

        const { completion } = this.objectives.request("go_to", { target });
        const result = await completion;
        if (result.status === "succeeded") {
            return success(`Reached (${target.x},${target.y}).`);
        }
        const reason = String(result.reason || "the objective stopped").trim();
        return failure(`Cannot reach (${target.x},${target.y}): ${reason}`);
    }

    /** @returns {Promise<ToolExecutionResult>} */
    async pickUp() {
        const { completion } = this.objectives.request("pickup");
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        const reason = String(result.reason || "the objective stopped").trim();
        return failure(
            reason === "no parcels were picked up"
                ? "Pickup failed: there are no parcels on the current tile."
                : `Pickup failed: ${reason}`
        );
    }

    /** @returns {Promise<ToolExecutionResult>} */
    async putDown() {
        const { completion } = this.objectives.request("putdown");
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        const reason = String(result.reason || "the objective stopped").trim();
        return failure(`Putdown failed: ${reason}`);
    }

    /**
     * @param {string} input
     * @returns {ToolExecutionResult}
     */
    applyStrategy(input) {
        let raw;
        try {
            raw = JSON.parse(String(input ?? ""));
        } catch {
            return failure("Cannot apply strategy: the input is not valid JSON.");
        }
        if (!isObject(raw)) {
            return failure("Cannot apply strategy: the input must be one JSON object.");
        }

        const result = this.beliefs.rules.apply(raw);
        if (!result.ok) return failure(`Cannot apply strategy: ${result.text}`);
        if (this.beliefs.partner.isKnown) {
            this.beliefs.partner.send("strategy", {
                operation: result.operation
            });
        }
        return success(result.text);
    }

    /**
     * @param {{x:number,y:number}} center
     * @param {number} radius
     * @param {string} rendezvousId
     * @param {number} deadline
     * @returns {Promise<ToolExecutionResult>}
     */
    async waitForRendezvous(center, radius, rendezvousId, deadline) {
        while (Date.now() < deadline) {
            if (!this.beliefs.partner.isKnown) {
                return failure("Rendezvous failed because the partner is no longer available.");
            }

            const myPosition = this.beliefs.me.pos;
            const partnerPosition = this.beliefs.partner.state;
            if (!isIntegerPosition(myPosition)) {
                return failure("Rendezvous failed because the local position is unavailable.");
            }
            if (!isIntegerPosition(partnerPosition)) {
                return failure("Rendezvous failed because the partner position is unavailable.");
            }

            if (!this.objectives.isActive(rendezvousId)) {
                return failure("Rendezvous stopped because its local hold was replaced.");
            }

            const bothInside = manhattanDistance(myPosition, center) <= radius
                && manhattanDistance(partnerPosition, center) <= radius;
            if (bothInside) {
                return success(
                    `Rendezvous completed near (${center.x},${center.y}): `
                    + `both agents are within radius ${radius}.`
                );
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs > 0) {
                await sleep(Math.min(COORDINATION_POLL_MS, remainingMs));
            }
        }

        return failure(
            "Rendezvous failed: both agents did not reach the requested area before the deadline."
        );
    }

    /**
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async rendezvous(input) {
        let request;
        try {
            request = JSON.parse(String(input ?? ""));
        } catch {
            return failure(
                "Cannot start rendezvous: the input is not valid JSON."
            );
        }
        if (!isObject(request)) {
            return failure(
                "Cannot start rendezvous: the input must be one JSON object."
            );
        }
        if (!Number.isInteger(request.x) || !Number.isInteger(request.y)
            || !Number.isInteger(request.radius) || request.radius < 0) {
            return failure(
                "Cannot start rendezvous: x and y must be integers and radius must be a non-negative integer."
            );
        }

        const world = this.beliefs.world;
        if (!this.beliefs.partner.isKnown) {
            return failure(
                "Cannot start rendezvous: no partner is configured."
            );
        }
        if (!isIntegerPosition(this.beliefs.me.pos)
            || !isPositionTraversable(this.beliefs, this.beliefs.me.pos)) {
            return failure(
                "Cannot start rendezvous: the local position is unavailable."
            );
        }
        if (!isIntegerPosition(this.beliefs.partner.state)
            || !isPositionTraversable(this.beliefs, this.beliefs.partner.state)) {
            return failure(
                "Cannot start rendezvous: the partner position is unavailable."
            );
        }

        const center = { x: request.x, y: request.y };
        const selection = selectRendezvousTargets(
            this.beliefs,
            center,
            request.radius
        );
        if (!selection) {
            return failure(
                "Cannot start rendezvous: no two distinct reachable tiles exist inside the requested area."
            );
        }

        const { myTarget, partnerTarget, myDistance, partnerDistance } =
            selection;
        const timeoutMoves = Math.max(myDistance, partnerDistance)
            + world.width
            + world.height;
        const timeoutMs = timeoutMoves * world.movementDurationMs();
        const holdSeconds = Math.ceil(timeoutMs / 1000) + 1;
        const startedAt = Date.now();
        const ownerId = String(this.beliefs.me.id || "agent").trim() || "agent";
        const rendezvousId = `rendezvous:${ownerId}:${startedAt}`;
        const deadline = startedAt + timeoutMs;
        const localHold = {
            id: rendezvousId,
            x: myTarget.x,
            y: myTarget.y,
            seconds: holdSeconds
        };
        const partnerHold = {
            id: rendezvousId,
            x: partnerTarget.x,
            y: partnerTarget.y,
            seconds: holdSeconds
        };
        trace("rendezvous", "selected", {
            id: rendezvousId,
            center: tileKey(center),
            radius: request.radius,
            local: tileKey(myTarget),
            partner: tileKey(partnerTarget)
        });

        try {
            this.objectives.request("hold", localHold);
        } catch (error) {
            return failure(
                `Cannot start rendezvous: ${error instanceof Error
                    ? error.message
                    : "invalid local hold"}.`
            );
        }

        try {
            this.beliefs.partner.send("hold", {
                hold: partnerHold
            });
            const result = await this.waitForRendezvous(
                center,
                request.radius,
                rendezvousId,
                deadline
            );
            trace("rendezvous", "completed", {
                id: rendezvousId,
                ok: result.ok,
                text: result.text
            });
            return result;
        } finally {
            this.objectives.clear(rendezvousId, "rendezvous cleanup");
            try {
                this.beliefs.partner.send("hold_clear", {
                    id: rendezvousId
                });
            } catch (error) {
                dbg("rendezvous cleanup message failed", error);
            }
        }
    }

    /**
     * @param {{localCompletion: Promise<object>, localRole: "giver" | "receiver",
     *     giverObjectiveId: string, receiverObjectiveId: string,
     *     parcelId: string, deadline: number}} options
     * @returns {Promise<ToolExecutionResult>}
     */
    async waitForHandoff(options) {
        const {
            localCompletion, localRole,
            giverObjectiveId, receiverObjectiveId,
            parcelId, deadline
        } = options;
        let localResult = null;

        void localCompletion.then(result => {
            localResult = result;
        });

        // Whichever role runs remotely is only observable through its result slot.
        const resultFor = (role, objectiveId) => role === localRole
            ? localResult
            : this.beliefs.partner.handoffResultFor(role, objectiveId);

        while (Date.now() < deadline) {
            const giverResult = resultFor("giver", giverObjectiveId);
            const receiverResult = resultFor("receiver", receiverObjectiveId);

            // A delivered parcel proves the transfer, whatever the giver reported.
            if (receiverResult?.status === "succeeded") {
                return success(
                    `Parcel handoff completed: parcel ${parcelId} was transferred `
                    + "and delivered by the receiver."
                );
            }

            const stopped = [
                { role: "giver", result: giverResult },
                { role: "receiver", result: receiverResult },
            ].find(({ result }) =>
                result?.status === "failed" || result?.status === "cancelled");
            if (stopped) {
                return failure(
                    `Parcel handoff failed: ${stopped.result.reason
                        || `the ${stopped.role} objective stopped`}.`
                );
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs > 0) {
                await sleep(Math.min(COORDINATION_POLL_MS, remainingMs));
            }
        }

        return failure(
            "Parcel handoff failed: the delivery was not completed before the deadline."
        );
    }

    /**
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async handoffParcel(input) {
        let request = null;
        try {
            request = JSON.parse(String(input ?? ""));
        } catch {}
        if (!isObject(request) || Object.keys(request).length !== 0) {
            return failure(
                "Cannot start parcel handoff: the input must be {}."
            );
        }

        const world = this.beliefs.world;
        if (!this.beliefs.partner.isKnown
            || !this.beliefs.me.id?.trim()
            || !this.beliefs.partner.id?.trim()
            || !isIntegerPosition(this.beliefs.me.pos)
            || !isIntegerPosition(this.beliefs.partner.state)
            || world.tiles.size === 0) {
            return failure(
                "Cannot start parcel handoff: the live map or agent state is unavailable."
            );
        }

        const configuration = selectHandoffConfiguration(this.beliefs);
        if (!configuration) {
            return failure(
                "Parcel handoff failed: no safe exchange configuration is reachable by both agents."
            );
        }

        const estimatedMs = configuration.estimatedMoves
            * world.movementDurationMs();
        const timeoutMs = Math.max(
            estimatedMs * HANDOFF_TIMEOUT_MARGIN,
            HANDOFF_MIN_TIMEOUT_MS
        );
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        const sessionId = `${this.beliefs.me.id}:${startedAt}`;
        const giverObjectiveId = `handoff:${sessionId}:giver`;
        const receiverObjectiveId = `handoff:${sessionId}:receiver`;
        const localIsGiver = configuration.giverId === this.beliefs.me.id;
        const localRole = localIsGiver ? "giver" : "receiver";
        const localObjectiveId = localIsGiver
            ? giverObjectiveId
            : receiverObjectiveId;
        const remoteObjectiveId = localIsGiver
            ? receiverObjectiveId
            : giverObjectiveId;
        const sharedFields = {
            type: "handoff",
            parcelId: configuration.parcel.id,
            giverId: configuration.giverId,
            receiverId: configuration.receiverId,
            parcelStart: configuration.parcelStart,
            handoffTile: configuration.handoffTile,
            waitTile: configuration.waitTile,
            exitTile: configuration.exitTile,
            deliveryTile: configuration.deliveryTile,
            expiresAt: deadline,
        };
        const giverObjective = {
            ...sharedFields,
            id: giverObjectiveId,
            peerObjectiveId: receiverObjectiveId,
            role: "giver",
            startPhase: configuration.giverStartPhase,
        };
        const receiverObjective = {
            ...sharedFields,
            id: receiverObjectiveId,
            peerObjectiveId: giverObjectiveId,
            role: "receiver",
            startPhase: configuration.receiverStartPhase,
        };
        const localObjective = localIsGiver ? giverObjective : receiverObjective;
        const remoteObjective = localIsGiver ? receiverObjective : giverObjective;
        trace("handoff", "selected", {
            id: sessionId,
            parcel: configuration.parcel.id,
            giver: configuration.giverId,
            phase: configuration.giverStartPhase,
            estimatedMoves: configuration.estimatedMoves,
            timeoutMs,
            start: tileKey(configuration.parcelStart),
            drop: tileKey(configuration.handoffTile),
            wait: tileKey(configuration.waitTile),
            exit: tileKey(configuration.exitTile),
            delivery: tileKey(configuration.deliveryTile)
        });

        let completion;
        try {
            ({ completion } = this.objectives.request(
                "handoff",
                localObjective
            ));
        } catch (error) {
            return failure(
                `Cannot start parcel handoff: ${error instanceof Error
                    ? error.message
                    : "invalid local objective"}.`
            );
        }

        // The partner's giver may be parked on its exit tile waiting for this,
        // so report the local objective the way a remote one already reports.
        void completion.then(result => {
            try {
                this.beliefs.partner.send("handoff_result", {
                    id: result.objectiveId,
                    role: localRole,
                    status: result.status,
                    reason: result.reason
                });
            } catch (error) {
                dbg("parcel handoff result message failed", error);
            }
        });

        try {
            // The LLM only requests the action. Both BDI loops execute it.
            this.beliefs.partner.send("handoff", {
                objective: remoteObjective
            });
            const result = await this.waitForHandoff({
                localCompletion: completion,
                localRole,
                giverObjectiveId,
                receiverObjectiveId,
                parcelId: configuration.parcel.id,
                deadline
            });
            trace("handoff", "completed", {
                id: sessionId,
                parcel: configuration.parcel.id,
                ok: result.ok,
                text: result.text
            });
            return result;
        } finally {
            this.objectives.clear(localObjectiveId, "parcel handoff cleanup");
            try {
                this.beliefs.partner.send("handoff_clear", {
                    id: remoteObjectiveId
                });
            } catch (error) {
                dbg("parcel handoff cleanup message failed", error);
            }
        }
    }
}

// Build the prompt from the registry so their tool descriptions stay aligned.
/** @param {LLMExecutor} executor */
export function buildSystemPrompt(executor) {
    const tools = Object.entries(executor.tools)
        .map(([name, tool]) => `- ${name}: ${tool.description}`)
        .join("\n");

    return `You play Deliveroo, a game on a grid. You pick up parcels, carry them
to a delivery tile and put them down there to score points. Players talk to you
in the chat and may give you a mission.

The current game state is included in every turn.
Use that state directly instead of asking for it again.
The bottom-left tile is (0,0). x grows to the right and y grows upwards.
Partner information is the last state reported by the other agent. If partner
information is missing, do not invent it.

Level 2 strategies remain active after the mission ends. Use set_strategy once
for each requested strategy change. The strategy is applied to this agent and
to its configured teammate. A multiplier can be zero. Use {"type":"clear"}
to remove the active Level 2 strategies.

For a mission that asks both agents to meet near one position, call rendezvous
once with the center and maximum Manhattan radius. The tool selects the two
target tiles and waits for both agents.

For a mission where one agent must pick up a parcel and the teammate must
deliver the same parcel, call handoff_parcel once with {}. The tool selects the
parcel and exchange point and waits for the delivery.

Your tools:
${tools}

Decide whether a mission is worth doing before taking action:
- a mission that awards negative points is never worth doing;
- a mission whose walk is long compared to what it pays is not worth doing
  either, because delivering ordinary parcels in that time pays more;
- when a mission is not worth it, use a brief Final Answer starting with
  "Declining:" and say why.
Missions sometimes write a coordinate as a calculation, such as x=4*2. Work it
out with calculate rather than in your head.

Answer with exactly one of these two shapes, and nothing else.

To use a tool:
Thought: <what you are doing and why>
Action: <the name of one tool>
Action Input: <its input, or nothing when it takes none>

When the goal is reached and there is nothing left to do:
Thought: <what you concluded>
Final Answer: <a short summary of what you did>

Take one step at a time. After each action you are given its result, and then
you choose the next step. Use Final Answer only when the mission is complete or
you decline it. The runtime sends that answer to the mission sender and closes
the mission automatically.`;
}
