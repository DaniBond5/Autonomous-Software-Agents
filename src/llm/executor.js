import config from "../config.js";
import {
    applyStrategyOperation,
    normalizeStrategyOperation
} from "../bdi/rules.js";
import {
    distanceFromSearch,
    isPositionTraversable,
    shortestPathsFrom
} from "../utils/geometry.js";

const dbg = (...args) => {
    if (config.debug) console.log("[llm]", ...args);
};

/**
 * @typedef {Object} ToolExecutionResult
 * @property {boolean} ok
 * @property {string} observation
 * @property {string | null} replanReason
 */

/** @param {string} observation @returns {ToolExecutionResult} */
function success(observation) {
    if (typeof observation !== "string") {
        throw new TypeError("a successful tool result needs a string observation");
    }
    const text = observation.trim();
    if (!text) throw new TypeError("a successful tool result needs an observation");
    return { ok: true, observation: text, replanReason: null };
}

/**
 * @param {string} observation
 * @param {string} replanReason
 * @returns {ToolExecutionResult}
 */
function failure(observation, replanReason) {
    if (typeof observation !== "string" || typeof replanReason !== "string") {
        throw new TypeError("a failed tool result needs string fields");
    }
    const text = observation.trim();
    const reason = replanReason.trim();
    if (!text || !reason) {
        throw new TypeError("a failed tool result needs an observation and a replan reason");
    }
    return { ok: false, observation: text, replanReason: reason };
}

/** Only digits, spaces, parentheses and the four operators are ever parsed. */
const ARITHMETIC = /^[\d+\-*/()\s]+$/;
const STRATEGY_SCOPES = new Set(["me", "teammate", "both"]);
const RENDEZVOUS_REPLAN_REASON = "the rendezvous could not be started or completed";
const rendezvousFailure = observation =>
    failure(observation, RENDEZVOUS_REPLAN_REASON);

const isObject = value => value !== null
    && typeof value === "object"
    && !Array.isArray(value);
const isIntegerPosition = position =>
    Number.isInteger(position?.x) && Number.isInteger(position?.y);
const manhattanDistance = (first, second) =>
    Math.abs(first.x - second.x) + Math.abs(first.y - second.y);

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

/**
 * The tools the model can call, and the only place they are described.
 * The system prompt is generated from this registry, so a new tool becomes
 * available to the model as soon as it is added here.
 * Every tool returns a structured result. The model sees the observation,
 * while a semantic failure also gives the planner one clear replan reason.
 */
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
                            `Cannot compute "${expression}": only numbers, + - * / and parentheses are allowed.`,
                            "the calculation input was invalid"
                        )
                        : success(`${expression} = ${value}`);
                },
            },
            set_stack_policy: {
                description: "Deliver only exact stacks of parcels. Input is JSON with "
                    + 'count, multiplier, and optional scope, for example '
                    + '{"count":3,"multiplier":2,"scope":"me"}.',
                run: input => this.runStrategyTool(input, "set_stack"),
            },
            set_delivery_policy: {
                description: "Set one multiplier for one or more known delivery tiles. "
                    + "Input is JSON with tiles, multiplier, and optional scope, for example "
                    + '{"tiles":[{"x":4,"y":7}],"multiplier":5,"scope":"both"}.',
                run: input => this.runStrategyTool(input, "set_delivery"),
            },
            set_parcel_value_policy: {
                description: "Set a multiplier for parcels above, below, at_least, or at_most "
                    + "one value. Input is JSON with comparison, value, multiplier, and "
                    + 'optional scope, for example {"comparison":"above","value":10,'
                    + '"multiplier":0,"scope":"me"}.',
                run: input => this.runStrategyTool(input, "set_parcel_value"),
            },
            avoid_tile: {
                description: "Never walk through one known map tile. Input is JSON with x, y, "
                    + 'and optional scope, for example {"x":3,"y":6,"scope":"both"}.',
                run: input => this.runStrategyTool(input, "avoid_tile"),
            },
            clear_strategy: {
                description: "Remove the selected agents' active Level 2 policies without "
                    + "removing a temporary hold. Input is JSON with optional scope, for "
                    + 'example {"scope":"both"}.',
                run: input => this.runStrategyTool(input, "clear"),
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
     * Runs one known tool and checks that it returned a consistent result.
     * Unexpected errors are logged here but only a safe observation reaches the model.
     * @param {string} name
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async run(name, input) {
        const toolName = typeof name === "string" ? name.trim() : "";
        if (!toolName || !Object.hasOwn(this.tools, toolName)) {
            const shownName = toolName || "(empty)";
            return failure(
                `Unknown tool: ${shownName}. Available tools: ${Object.keys(this.tools).join(", ")}.`,
                toolName
                    ? `the selected tool "${toolName}" does not exist`
                    : "the selected tool name was invalid"
            );
        }

        const tool = this.tools[toolName];
        dbg(`${toolName}(${input ?? ""})`);
        try {
            const result = await tool.run(input);
            const validSuccess = result?.ok === true
                && result.replanReason === null;
            const validFailure = result?.ok === false
                && typeof result.replanReason === "string"
                && Boolean(result.replanReason.trim());
            if ((!validSuccess && !validFailure)
                || typeof result?.observation !== "string"
                || !result.observation.trim()) {
                throw new TypeError(`${toolName} returned an invalid tool result`);
            }
            return result;
        } catch (error) {
            console.error(`[llm] ${toolName} tool failed unexpectedly:`, error);
            return failure(
                "The tool failed because of an internal error.",
                `the ${toolName} tool failed unexpectedly`
            );
        }
    }

    /**
     * Publishes a tile objective and waits for the BDI loop to report its result.
     * @param {string} input
     * @returns {Promise<ToolExecutionResult>}
     */
    async goTo(input) {
        const target = parseTile(input);
        if (!target) {
            return failure(
                `Cannot read "${input}" as a tile. Write it as x,y.`,
                "the go_to input was not a valid tile"
            );
        }

        const { completion } = this.objectives.requestGoTo(target);
        const result = await completion;
        if (result.status === "succeeded") {
            return success(`Reached (${target.x},${target.y}).`);
        }
        if (result.status === "failed") {
            const reason = String(result.reason || "no path was found").trim();
            return failure(
                `Cannot reach (${target.x},${target.y}): ${reason}`,
                `the target tile (${target.x},${target.y}) could not be reached: ${reason}`
            );
        }
        if (result.status === "cancelled") {
            const reason = String(result.reason || "the objective was cancelled").trim();
            return failure(
                `Go-to (${target.x},${target.y}) was cancelled: ${reason}`,
                `the go_to objective for (${target.x},${target.y}) was cancelled: ${reason}`
            );
        }
        throw new TypeError("go_to received an unknown objective result");
    }

    /**
     * Requests one pickup and waits for the BDI loop to return the server result.
     * @returns {Promise<ToolExecutionResult>}
     */
    async pickUp() {
        const { completion } = this.objectives.requestPickup();
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        if (result.status === "failed") {
            const reason = String(result.reason || "pickup failed").trim();
            return failure(
                `Pickup failed: ${reason}`,
                reason === "no parcels were picked up"
                    ? "there were no parcels available on the current tile"
                    : `the pickup could not be completed: ${reason}`
            );
        }
        if (result.status === "cancelled") {
            const reason = String(result.reason || "the objective was cancelled").trim();
            return failure(
                `Pickup was cancelled: ${reason}`,
                `the pickup objective was cancelled: ${reason}`
            );
        }
        throw new TypeError("pick_up received an unknown objective result");
    }

    /**
     * Requests one putdown and waits for the BDI loop to return the server result.
     * @returns {Promise<ToolExecutionResult>}
     */
    async putDown() {
        const { completion } = this.objectives.requestPutdown();
        const result = await completion;
        if (result.status === "succeeded") return success(result.reason);
        if (result.status === "failed") {
            const reason = String(result.reason || "putdown failed").trim();
            let replanReason = `the putdown could not be completed: ${reason}`;
            if (reason === "not carrying any parcels") {
                replanReason = "the agent is not carrying any parcels to put down";
            } else if (reason === "no parcels were put down") {
                replanReason = "no parcels were put down on the current tile";
            }
            return failure(`Putdown failed: ${reason}`, replanReason);
        }
        if (result.status === "cancelled") {
            const reason = String(result.reason || "the objective was cancelled").trim();
            return failure(
                `Putdown was cancelled: ${reason}`,
                `the putdown objective was cancelled: ${reason}`
            );
        }
        throw new TypeError("put_down received an unknown objective result");
    }

    /** Parses one semantic tool input and sends it through the scoped strategy path. */
    runStrategyTool(input, type) {
        let raw;
        try {
            raw = JSON.parse(String(input ?? ""));
        } catch {
            return failure(
                "Cannot apply strategy: the input is not valid JSON.",
                "the requested strategy could not be applied to the selected scope"
            );
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return failure(
                "Cannot apply strategy: the input must be one JSON object.",
                "the requested strategy could not be applied to the selected scope"
            );
        }

        const { scope = "me", type: _ignoredType, ...fields } = raw;
        return this.applyScopedStrategy({ type, ...fields }, scope);
    }

    /**
     * Scope controls where the same normalized operation is applied.
     * Each receiver stores it locally and does not send it back.
     */
    applyScopedStrategy(rawOperation, scope) {
        if (!STRATEGY_SCOPES.has(scope)) {
            return failure(
                'Cannot apply strategy: scope must be "me", "teammate", or "both".',
                "the requested strategy could not be applied to the selected scope"
            );
        }

        const normalized = normalizeStrategyOperation(rawOperation);
        if (!normalized.ok) {
            return failure(
                `Cannot apply strategy: ${normalized.reason}.`,
                "the requested strategy could not be applied to the selected scope"
            );
        }
        const operation = normalized.operation;

        if (operation.type === "set_delivery") {
            const unknown = operation.tiles.find(tile =>
                !this.beliefs.world.deliveries.has(`${tile.x},${tile.y}`)
            );
            if (unknown) {
                return failure(
                    `Cannot apply strategy: (${unknown.x},${unknown.y}) is not a known delivery tile.`,
                    "the requested strategy could not be applied to the selected scope"
                );
            }
        }
        if (operation.type === "avoid_tile"
            && !this.beliefs.world.tiles.has(`${operation.x},${operation.y}`)) {
            return failure(
                `Cannot apply strategy: (${operation.x},${operation.y}) is not a known map tile.`,
                "the requested strategy could not be applied to the selected scope"
            );
        }

        const includesTeammate = scope === "teammate" || scope === "both";
        if (includesTeammate && !this.beliefs.partner.isKnown) {
            return failure(
                "Cannot apply the policy to the teammate: no partner is configured.",
                "the requested strategy could not be applied to the selected scope"
            );
        }

        if (scope === "me" || scope === "both") {
            const applied = applyStrategyOperation(this.beliefs.rules, operation);
            if (!applied.ok) {
                return failure(
                    `Cannot apply strategy: ${applied.reason}.`,
                    "the requested strategy could not be applied to the selected scope"
                );
            }
        }
        if (includesTeammate) this.beliefs.partner.shareStrategy(operation);

        return success(this.strategyObservation(operation, scope));
    }

    strategyObservation(operation, scope) {
        const target = scope === "me"
            ? "this agent"
            : scope === "teammate"
                ? "the teammate"
                : "both agents";
        switch (operation.type) {
            case "set_stack":
                return `Stack policy set for ${target}: deliver exactly ${operation.count} `
                    + `parcels with multiplier ${operation.multiplier}.`;
            case "set_delivery":
                return `Delivery policy set for ${target}: ${operation.tiles
                    .map(tile => `(${tile.x},${tile.y})`).join(", ")} have multiplier `
                    + `${operation.multiplier}.`;
            case "set_parcel_value":
                return `Parcel value policy set for ${target}: parcels ${operation.comparison} `
                    + `${operation.value} have multiplier ${operation.multiplier}.`;
            case "avoid_tile":
                return `Avoided tile (${operation.x},${operation.y}) set for ${target}.`;
            default:
                return `Level 2 strategy cleared for ${target}.`;
        }
    }

    /**
     * Sends this agent to a tile for a while.
     * @param {string} input tile and seconds
     * @returns {Promise<ToolExecutionResult>}
     */
    async hold(input) {
        const hold = parseHold(input);
        if (!hold) {
            return failure(
                `Cannot read "${input}". Write it as x,y seconds.`,
                "the hold_at input was invalid"
            );
        }

        const result = this.beliefs.rules.setHold({
            id: `hold ${hold.x},${hold.y}`,
            ...hold
        });
        return result.ok
            ? success(result.summary)
            : failure(
                `Cannot hold there: ${result.reason}`,
                `the hold request was invalid: ${result.reason}`
            );
    }

    async waitForRendezvous(center, radius, rendezvousId, deadline) {
        let revision = this.beliefs.sensingRevision;

        while (Date.now() < deadline) {
            if (!this.beliefs.partner.isKnown) {
                return rendezvousFailure(
                    "Rendezvous failed because the partner is no longer available."
                );
            }

            const myPosition = this.beliefs.me.pos;
            const partnerPosition = this.beliefs.partner.state;
            if (!isIntegerPosition(myPosition)) {
                return rendezvousFailure(
                    "Rendezvous failed because the local position is unavailable."
                );
            }
            if (!isIntegerPosition(partnerPosition)) {
                return rendezvousFailure(
                    "Rendezvous failed because the partner position is unavailable."
                );
            }

            if (this.beliefs.rules.activeHold()?.id !== rendezvousId) {
                return rendezvousFailure(
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

        return rendezvousFailure(
            "Rendezvous failed: both agents did not reach the requested area before the deadline."
        );
    }

    /** Selects two targets, installs their holds, and waits for both BDI agents. */
    async rendezvous(input) {
        let request;
        try {
            request = JSON.parse(String(input ?? ""));
        } catch {
            return rendezvousFailure(
                "Cannot start rendezvous: the input is not valid JSON."
            );
        }
        if (!isObject(request)) {
            return rendezvousFailure(
                "Cannot start rendezvous: the input must be one JSON object."
            );
        }
        if (!Number.isInteger(request.x) || !Number.isInteger(request.y)
            || !Number.isInteger(request.radius) || request.radius < 0) {
            return rendezvousFailure(
                "Cannot start rendezvous: x and y must be integers and radius must be a non-negative integer."
            );
        }

        const world = this.beliefs.world;
        if (world.tiles.size === 0 || world.width <= 0 || world.height <= 0) {
            return rendezvousFailure(
                "Cannot start rendezvous: the map is not available yet."
            );
        }
        if (!this.beliefs.partner.isKnown) {
            return rendezvousFailure(
                "Cannot start rendezvous: no partner is configured."
            );
        }
        if (!isIntegerPosition(this.beliefs.me.pos)
            || !isPositionTraversable(this.beliefs, this.beliefs.me.pos)) {
            return rendezvousFailure(
                "Cannot start rendezvous: the local position is unavailable."
            );
        }
        if (!isIntegerPosition(this.beliefs.partner.state)
            || !isPositionTraversable(this.beliefs, this.beliefs.partner.state)) {
            return rendezvousFailure(
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
            return rendezvousFailure(
                "Cannot start rendezvous: the requested area does not intersect the known map."
            );
        }
        if (!selection.assignment) {
            return rendezvousFailure(
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
            return rendezvousFailure(
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
            return rendezvousFailure(
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

Level 2 policies stay active after the mission ends. Use one semantic policy
tool for each requested strategy change. Use scope "me" for this agent only,
scope "teammate" for the BDI partner only, and scope "both" only when the
mission explicitly applies to both agents. A multiplier can be zero. Use
clear_strategy only when the active Level 2 strategy must be removed.

For a mission that asks both agents to meet near one position, call rendezvous
once with the center and maximum Manhattan radius. The tool selects the two
target tiles and waits for both agents. Do not combine rendezvous with hold_at.

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
