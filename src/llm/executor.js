import config from "../config.js";
import { preferOperationalDeliveryCandidates } from "../bdi/desires.js";
import {
    distanceFromSearch,
    isMoveAllowed,
    isPositionTraversable,
    shortestPathsFrom
} from "../utils/geometry.js";

const dbg = (...args) => {
    if (config.debug) console.log("[llm]", ...args);
};

/** @typedef {{ok: boolean, text: string}} ToolExecutionResult */

const success = text => ({ ok: true, text });
const failure = text => ({ ok: false, text });

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
const compareHandoffCandidates = (first, second) =>
    first.cost - second.cost
    || compareStrings(first.parcel.id, second.parcel.id)
    || compareTiles(first.handoffTile, second.handoffTile);
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

function selectHandoffConfiguration(beliefs) {
    const isBlockedByCrate = position => beliefs.crates.isOccupied(position);
    const pathOptions = { isBlocked: isBlockedByCrate };
    const giverPaths = shortestPathsFrom(beliefs, beliefs.me.pos, pathOptions);
    const receiverPaths = shortestPathsFrom(
        beliefs,
        beliefs.partner.state,
        pathOptions
    );
    const freeParcels = freeKnownParcels(beliefs);
    const parcels = freeParcels
        .map(parcel => ({
            parcel,
            giverPickupDistance: distanceFromSearch(giverPaths, parcel),
        }))
        .filter(({ parcel, giverPickupDistance }) =>
            isPositionTraversable(beliefs, parcel)
            && !beliefs.world.deliveries.has(tileKey(parcel))
            && !beliefs.rules.isAvoided(parcel)
            && Number.isFinite(giverPickupDistance))
        .sort((first, second) =>
            first.giverPickupDistance - second.giverPickupDistance
            || compareStrings(first.parcel.id, second.parcel.id)
        );
    const occupiedByFreeParcel = new Set(freeParcels.map(tileKey));
    const configurations = [];

    for (const { parcel, giverPickupDistance } of parcels) {
        let parcelConfiguration = null;
        const handoffTiles = adjacentTiles(beliefs, parcel)
            .filter(tile => isPositionTraversable(beliefs, tile)
                && isMoveAllowed(beliefs, parcel, tile)
                && !beliefs.world.deliveries.has(tileKey(tile))
                && !beliefs.world.spawners.has(tileKey(tile))
                && !beliefs.world.isCrateSpace(tile)
                && !beliefs.crates.isOccupied(tile)
                && !beliefs.rules.isAvoided(tile)
                && !occupiedByFreeParcel.has(tileKey(tile)))
            .sort(compareTiles);

        for (const handoffTile of handoffTiles) {
            const neighbors = adjacentTiles(beliefs, handoffTile)
                .filter(tile => isPositionTraversable(beliefs, tile)
                    && !beliefs.crates.isOccupied(tile)
                    && !beliefs.rules.isAvoided(tile))
                .sort(compareTiles);
            const wait = neighbors
                .filter(tile => !samePosition(tile, parcel)
                    && isMoveAllowed(beliefs, tile, handoffTile)
                    && Number.isFinite(distanceFromSearch(receiverPaths, tile)))
                .map(tile => ({
                    tile,
                    distance: distanceFromSearch(receiverPaths, tile),
                }))
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

            const handoffPaths = shortestPathsFrom(
                beliefs,
                handoffTile,
                pathOptions
            );
            const deliveries = [...beliefs.world.deliveries.values()]
                .map(delivery => ({
                    delivery,
                    distance: distanceFromSearch(handoffPaths, delivery),
                }))
                .filter(candidate => !beliefs.rules.isAvoided(candidate.delivery)
                    && Number.isFinite(candidate.distance));
            const selectedDelivery = preferOperationalDeliveryCandidates(
                beliefs,
                deliveries
            ).sort((first, second) =>
                first.distance - second.distance
                || compareTiles(first.delivery, second.delivery)
            )[0];
            if (!selectedDelivery) continue;

            const giverHandoffDistance = 1;
            const cost = giverPickupDistance
                + giverHandoffDistance
                + wait.distance
                + selectedDelivery.distance;
            const candidate = {
                parcel: { id: parcel.id, x: parcel.x, y: parcel.y },
                handoffTile,
                waitTile: wait.tile,
                exitTile,
                deliveryTile: copyPoint(selectedDelivery.delivery),
                cost,
            };
            if (!parcelConfiguration
                || compareHandoffCandidates(candidate, parcelConfiguration) < 0) {
                parcelConfiguration = candidate;
            }
        }

        if (parcelConfiguration) configurations.push(parcelConfiguration);
    }

    configurations.sort(compareHandoffCandidates);
    return configurations[0] ?? null;
}

function compareRendezvousAssignments(first, second) {
    const firstRank = [
        Math.max(first.myDistance, first.partnerDistance),
        first.myDistance + first.partnerDistance,
        first.myTarget.x,
        first.myTarget.y,
        first.partnerTarget.x,
        first.partnerTarget.y
    ];
    const secondRank = [
        Math.max(second.myDistance, second.partnerDistance),
        second.myDistance + second.partnerDistance,
        second.myTarget.x,
        second.myTarget.y,
        second.partnerTarget.x,
        second.partnerTarget.y
    ];
    for (let index = 0; index < firstRank.length; index += 1) {
        if (firstRank[index] !== secondRank[index]) {
            return firstRank[index] - secondRank[index];
        }
    }
    return 0;
}

function selectRendezvousTargets(beliefs, center, radius) {
    const region = [...beliefs.world.tiles.values()]
        .filter(tile => isIntegerPosition(tile)
            && manhattanDistance(tile, center) <= radius)
        .map(tile => ({ x: tile.x, y: tile.y }));
    const candidates = region.filter(tile =>
        isPositionTraversable(beliefs, tile)
        && !beliefs.rules.isAvoided(tile)
    );
    const isBlockedByCrate = position => beliefs.crates.isOccupied(position);
    const myPaths = shortestPathsFrom(beliefs, beliefs.me.pos, {
        isBlocked: isBlockedByCrate
    });
    const partnerPaths = shortestPathsFrom(beliefs, beliefs.partner.state, {
        isBlocked: isBlockedByCrate
    });

    let best = null;
    for (const myTarget of candidates) {
        const myDistance = distanceFromSearch(myPaths, myTarget);
        if (!Number.isFinite(myDistance)) continue;

        for (const partnerTarget of candidates) {
            if (myTarget.x === partnerTarget.x
                && myTarget.y === partnerTarget.y) continue;
            const partnerDistance = distanceFromSearch(partnerPaths, partnerTarget);
            if (!Number.isFinite(partnerDistance)) continue;

            const assignment = {
                myTarget,
                partnerTarget,
                myDistance,
                partnerDistance
            };
            if (!best || compareRendezvousAssignments(assignment, best) < 0) {
                best = assignment;
            }
        }
    }

    return { regionIntersectsMap: region.length > 0, assignment: best };
}

/**
 * Evaluates an arithmetic expression without eval, which would run whatever
 * the sender wrote inside our process. Anything outside plain arithmetic is
 * rejected before parsing, and the parser itself only knows numbers.
 * @param {string} expression
 * @returns {number | null} the value, or null when the input is not arithmetic
 */
export function evaluateExpression(expression) {
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

/**
 * Reads a tile out of what the model wrote, accepting the shapes it tends to
 * produce for a pair of coordinates.
 * @param {string} input
 * @returns {{x: number, y: number} | null}
 */
function parseTile(input) {
    const numbers = String(input ?? "").match(/-?\d+/g);
    if (!numbers || numbers.length < 2) return null;
    return { x: Number(numbers[0]), y: Number(numbers[1]) };
}

/**
 * Reads a tile and a duration for the local hold tool.
 * @param {string} input
 * @returns {{x: number, y: number, seconds: number} | null}
 */
function parseHold(input) {
    const numbers = String(input ?? "").match(/-?\d+/g);
    if (!numbers || numbers.length < 3) return null;
    const hold = {
        x: Number(numbers[0]),
        y: Number(numbers[1]),
        seconds: Number(numbers[2])
    };
    return hold.seconds > 0 ? hold : null;
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
            hold_at: {
                description: "Go to a tile and wait there, then go back to playing. Input is "
                    + 'the tile and the seconds to wait, for example "4,7 30". Use it for a '
                    + "mission that asks you to be somewhere at a time.",
                run: input => this.hold(input),
            },
            rendezvous: {
                description: "Move both agents near one position and wait for both to arrive. "
                    + "Input is JSON with integer x, y, and a non-negative Manhattan radius, "
                    + 'for example {"x":4,"y":7,"radius":3}.',
                run: input => this.rendezvous(input),
            },
            handoff_parcel: {
                description: "Have this agent pick up one parcel and the teammate deliver "
                    + "that same parcel. Input must be {}. The runtime selects the parcel "
                    + "and safe exchange tiles, then waits for delivery.",
                run: input => this.handoffParcel(input),
            },
        };
    }

    /** @param {string} reason */
    cancelPendingObjective(reason) {
        return this.objectives.cancelActive(reason);
    }

    /**
     * Sends the final mission result to its immutable sender.
     * @param {string} senderId
     * @param {string} message
     * @returns {Promise<string>}
     */
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

    /**
     * Runs one known tool. Unexpected errors are logged here, while the model
     * receives only a safe result.
     * @param {string} name
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async run(name, input) {
        const toolName = typeof name === "string" ? name.trim() : "";
        if (!toolName || !Object.hasOwn(this.tools, toolName)) {
            const shownName = toolName || "(empty)";
            return failure(
                `Unknown tool: ${shownName}. Available tools: ${Object.keys(this.tools).join(", ")}.`
            );
        }

        dbg(`${toolName}(${input ?? ""})`);
        try {
            return await this.tools[toolName].run(input);
        } catch (error) {
            console.error(`[llm] ${toolName} tool failed unexpectedly:`, error);
            return failure("The tool failed because of an internal error.");
        }
    }

    async goTo(input) {
        const target = parseTile(input);
        if (!target) {
            return failure(
                `Cannot read "${input}" as a tile. Write it as x,y.`
            );
        }

        const { completion } = this.objectives.requestGoTo(target);
        const result = await completion;
        if (result.status === "succeeded") {
            return success(`Reached (${target.x},${target.y}).`);
        }
        const reason = String(result.reason || "the objective stopped").trim();
        return failure(`Cannot reach (${target.x},${target.y}): ${reason}`);
    }

    async pickUp() {
        const { completion } = this.objectives.requestPickup();
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        const reason = String(result.reason || "the objective stopped").trim();
        return failure(
            reason === "no parcels were picked up"
                ? "Pickup failed: there are no parcels on the current tile."
                : `Pickup failed: ${reason}`
        );
    }

    async putDown() {
        const { completion } = this.objectives.requestPutdown();
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        const reason = String(result.reason || "the objective stopped").trim();
        return failure(`Putdown failed: ${reason}`);
    }

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
            this.beliefs.partner.shareStrategy(result.operation);
        }
        return success(result.text);
    }

    /**
     * Sends this agent to a tile for a while.
     * @param {string} input tile and seconds
     * @returns {Promise<ToolExecutionResult>}
     */
    async hold(input) {
        const hold = parseHold(input);
        if (!hold) {
            return failure(`Cannot read "${input}". Write it as x,y seconds.`);
        }

        const result = this.beliefs.rules.setHold({
            id: `hold ${hold.x},${hold.y}`,
            ...hold
        });
        return result.ok
            ? success(result.summary)
            : failure(`Cannot hold there: ${result.reason}`);
    }

    async waitForRendezvous(center, radius, rendezvousId, deadline) {
        let revision = this.beliefs.sensingRevision;

        while (Date.now() < deadline) {
            if (!this.beliefs.partner.isKnown) {
                return failure(
                    "Rendezvous failed because the partner is no longer available."
                );
            }

            const myPosition = this.beliefs.me.pos;
            const partnerPosition = this.beliefs.partner.state;
            if (!isIntegerPosition(myPosition)) {
                return failure(
                    "Rendezvous failed because the local position is unavailable."
                );
            }
            if (!isIntegerPosition(partnerPosition)) {
                return failure(
                    "Rendezvous failed because the partner position is unavailable."
                );
            }

            if (this.beliefs.rules.activeHold()?.id !== rendezvousId) {
                return failure(
                    "Rendezvous stopped because its local hold was replaced."
                );
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
            if (remainingMs <= 0) break;
            await this.beliefs.waitForSensingAfter(revision, remainingMs);
            revision = this.beliefs.sensingRevision;
        }

        return failure(
            "Rendezvous failed: both agents did not reach the requested area before the deadline."
        );
    }

    /** Selects two targets, installs their holds, and waits for both BDI agents. */
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
        if (world.tiles.size === 0 || world.width <= 0 || world.height <= 0) {
            return failure(
                "Cannot start rendezvous: the map is not available yet."
            );
        }
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
        if (!selection.regionIntersectsMap) {
            return failure(
                "Cannot start rendezvous: the requested area does not intersect the known map."
            );
        }
        if (!selection.assignment) {
            return failure(
                "Cannot start rendezvous: there are not two distinct reachable tiles inside the requested area."
            );
        }

        // The runtime selects two different reachable tiles.
        // Both BDI loops remain responsible for movement.
        const { myTarget, partnerTarget, myDistance, partnerDistance } =
            selection.assignment;
        const longestDistance = Math.max(myDistance, partnerDistance);
        const movementDuration = world.movementDurationMs();
        const timeoutMoves = longestDistance + world.width + world.height;
        const timeoutMs = timeoutMoves * movementDuration;
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

        const registered = this.beliefs.rules.setHold(localHold);
        if (!registered.ok) {
            return failure(
                `Cannot start rendezvous: ${registered.reason}.`
            );
        }

        try {
            this.beliefs.partner.shareHold(partnerHold);
            return await this.waitForRendezvous(
                center,
                request.radius,
                rendezvousId,
                deadline
            );
        } catch (error) {
            console.error("[llm] rendezvous coordination failed:", error);
            return failure(
                "Rendezvous failed because coordination could not be completed."
            );
        } finally {
            // Clear only the hold created by this rendezvous.
            // A newer hold must not be removed.
            this.beliefs.rules.clearHold(rendezvousId);
            try {
                this.beliefs.partner.shareHoldClear(rendezvousId);
            } catch (error) {
                console.warn("[llm] rendezvous cleanup message failed:", error);
            }
        }
    }

    async waitForHandoff(configuration, giverCompletion, deadline) {
        let giverResult = null;
        let receiverPicked = false;
        const parcelId = configuration.parcel.id;
        let revision = this.beliefs.sensingRevision;

        void giverCompletion.then(result => {
            giverResult = result;
            this.beliefs.advanceSensingRevision();
        });

        while (Date.now() < deadline) {
            const partnerState = this.beliefs.partner.state;
            const partnerCarries = Array.isArray(partnerState?.carriedParcelIds)
                && partnerState.carriedParcelIds.includes(parcelId);
            if (partnerCarries) receiverPicked = true;

            if (giverResult?.status === "failed"
                || giverResult?.status === "cancelled") {
                return failure(
                    `Parcel handoff failed: ${giverResult.reason || "the giver objective stopped"}.`
                );
            }
            if (giverResult?.status === "succeeded"
                && receiverPicked
                && !partnerCarries
                && samePosition(partnerState, configuration.deliveryTile)) {
                return success(
                    `Parcel handoff completed: the teammate delivered parcel ${parcelId} `
                    + "after receiving it from this agent."
                );
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            await this.beliefs.waitForSensingAfter(revision, remainingMs);
            revision = this.beliefs.sensingRevision;
        }

        return failure(
            "Parcel handoff failed: the delivery was not completed before the deadline."
        );
    }

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
            || !Array.isArray(this.beliefs.partner.state?.carriedParcelIds)) {
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

        const estimatedMoves = configuration.cost + 4;
        const timeoutMoves = estimatedMoves + world.width + world.height;
        const timeoutMs = timeoutMoves * world.movementDurationMs();
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        const sessionId = `${this.beliefs.me.id}:${startedAt}`;
        const giverObjectiveId = `handoff:${sessionId}:giver`;
        const receiverObjectiveId = `handoff:${sessionId}:receiver`;
        const sharedFields = {
            type: "handoff",
            parcelId: configuration.parcel.id,
            giverId: this.beliefs.me.id,
            receiverId: this.beliefs.partner.id,
            parcelStart: copyPoint(configuration.parcel),
            handoffTile: configuration.handoffTile,
            waitTile: configuration.waitTile,
            exitTile: configuration.exitTile,
            deliveryTile: configuration.deliveryTile,
            expiresAt: deadline,
        };
        const giverObjective = {
            ...sharedFields, id: giverObjectiveId, role: "giver"
        };
        const receiverObjective = {
            ...sharedFields, id: receiverObjectiveId, role: "receiver"
        };

        try {
            // The LLM only requests the action. Both BDI loops execute it.
            const { completion } = this.objectives.requestHandoff(
                giverObjective
            );
            this.beliefs.partner.shareHandoff(receiverObjective);
            return await this.waitForHandoff(
                configuration,
                completion,
                deadline
            );
        } catch (error) {
            console.error("[llm] parcel handoff coordination failed:", error);
            return failure(
                "Parcel handoff failed because coordination could not be completed."
            );
        } finally {
            this.objectives.clear(giverObjectiveId, "parcel handoff cleanup");
            try {
                this.beliefs.partner.shareHandoffClear(receiverObjectiveId);
            } catch (error) {
                console.warn("[llm] parcel handoff cleanup message failed:", error);
            }
        }
    }
}

// The prompt lives next to the registry above because it is written from it.
// Apart, the two drift in silence: the model would be told about a tool that is
// gone, or never hear about one that is there.

/**
 * Builds the system prompt from the tool registry.
 * The registry is the only description of the tools, so adding one there is
 * enough for the model to learn about it: nothing has to be edited twice.
 * @param {LLMExecutor} executor
 * @returns {string}
 */
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
target tiles and waits for both agents. Do not combine rendezvous with hold_at.

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
