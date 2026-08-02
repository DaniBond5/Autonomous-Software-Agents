# Autonomous Software Agents - Deliveroo.js

An autonomous agent that plays Deliveroo.js on the user's behalf, collecting and delivering
parcels. Built on a BDI (Belief-Desire-Intention) architecture with automated planning.

**Course:** Autonomous Software Agents - University of Trento

**Authors:** Sasha Petkovic (sasha.petkovic@studenti.unitn.it, 264689), Daniele Buondonno (daniele.buondonno@studenti.unitn.it, 267888)

**Report:** 

---

## Overview

The agent runs one BDI cycle per action. Each cycle it refreshes its beliefs from the
latest sensing event, generates the goals that are achievable right now, commits to one of
them, and plans a **single** next action toward it. Planning one step at a time is what
keeps the agent reactive: it is never locked into a multi-step plan that the world can
invalidate halfway through.

| Stage of the cycle | Where it lives |
|---|---|
| Beliefs — own state, parcels, other agents, crates, map, partner | `src/bdi/beliefs.js` |
| Desires — candidate goals, each scored by a utility | `src/bdi/desires.js` |
| Intention — commitment to one goal, and its revision | `src/bdi/intentions.js` |
| Plan — route to the goal, plus the plan library | `src/bdi/planning.js` |
| Execution — move, pickup and putdown on the socket | `src/bdi/execution.js` |
| Control loop — wires the stages together | `src/bdi/loop.js` |

Routing normally uses breadth-first search over the walkable tiles, which is optimal on a
uniform-cost grid. When movable crates block every ordinary route, the agent falls back to
a PDDL planner that can reason about pushing them out of the way.

The reasoning behind each design decision, and the known limitations, are covered in the
report.

---

## Prerequisites

- Node.js 18 or newer, and npm
- A running Deliveroo.js server
- One Deliveroo.js agent token per agent, each under a different name
- Internet access, for the online PDDL solver

## Setup

**1. Install the dependencies.** This step is required: `node_modules/` is not part of the
repository.

```bash
npm ci
```

Use `npm install` if you do not have a `package-lock.json`.

**2. Start a Deliveroo.js server.** Follow the instructions in the
[Deliveroo.js repository](https://github.com/unitn-ASA/Deliveroo.js):

```bash
git clone https://github.com/unitn-ASA/Deliveroo.js.git
cd Deliveroo.js && npm install && npm run build && npm start
```

The server listens on `http://localhost:8080`.

**3. Get a token.** Open the server address in a browser, enter a name for the player, and
copy the token that is generated. Each token identifies one player: give the agent a token
that no one else is using, or you will both be controlling the same character.

**4. Create the environment file.**

```bash
cp .env.example .env
```

Then fill it in:

```env
HOST=http://localhost:8080
TOKEN=your_agent_token
BDI_NAME=
LLM_TOKEN=
LLM_NAME=
```

Everything below `TOKEN` concerns the second agent and can be left empty to run the BDI
agent alone.

`BDI_NAME` and `LLM_NAME` are the names the two tokens were created with. They have to
differ from each other: they are how each agent recognises the other among the connected
players. Leaving them empty is a supported setting and means the agent plays alone.

`.env` is ignored by git and must not be committed.

## Running

```bash
npm start
```

Open the server address in a browser with the same token to watch the agent play from its
own point of view.

To run both agents, get a second token under a second name, fill in all five settings, and
start one agent per terminal:

```bash
npm start        # first terminal, the BDI agent
npm run start:llm  # second terminal, the LLM agent
```

The order does not matter, and the two terminals do not have to be on the same machine as
long as both reach the same server. Each process logs the line `[partner] <name> is agent
<id>` once it has recognised the other. Without that line the two are playing next to each
other rather than together, and the usual cause is a name that does not match the one the
token was created with.

## Configuration

Credentials live in `.env`. Everything else is in `src/config.js`:

| Key | Purpose |
|---|---|
| `debug` | Enables the runtime log written to standard output |
| `pddl.timeoutMs` | How long to wait for the online solver before giving up |
| `pddl.retryMs` | How long to wait before retrying a failed solver request |

## Repository structure

```text
.
├── .env.example              # template for the local credentials file
├── .gitignore                # keeps node_modules/ and .env out of the repository
├── package.json              # dependencies and the start script
├── package-lock.json         # pinned dependency versions, so installs are reproducible
├── README.md                 # this file
└── src/
    ├── agent.js              # entry point of the BDI agent
    ├── llm-agent.js          # entry point of the LLM agent, and its chat handler
    ├── config.js             # runtime settings; credentials are read from .env
    ├── bdi/
    │   ├── beliefs.js        # world model: Me, Parcels, Agents, Crates, World, Partner
    │   ├── desires.js        # candidate goals, their utility, and parcels yielded to the partner
    │   ├── intentions.js     # commitment to one goal, and when to give it up
    │   ├── planning.js       # Planner: routing, plan library, deferred goals
    │   ├── execution.js      # move, pickup and putdown on the socket, one action at a time
    │   ├── rules.js          # RuleStore: the rules a mission put in force
    │   └── loop.js           # BDI control loop, shared by both agents
    ├── llm/
    │   ├── core.js           # Agent Core: holds the others together and runs one turn
    │   ├── memory.js         # LLM-memory: the objective and the observations
    │   ├── planner.js        # LLM-Planner: turns the objective into an action
    │   ├── replanner.js      # LLM-Replanner: decides when the plan needs revisiting
    │   ├── executor.js       # Tools: the registry, and the prompt that describes it
    │   └── client.js         # access to the model, so the provider is a config value
    ├── pddl/
    │   ├── crate-planner.js  # CratePlanner: PDDL routes around movable crates
    │   └── crates-domain.pddl # PDDL domain: actions for moving and pushing
    └── utils/
        └── geometry.js       # breadth-first search, distances and grid geometry
```

## Dependencies

| Package | Version | Purpose |
|---|---:|---|
| `@unitn-asa/deliveroo-js-sdk` | `^1.3.10` | Connection and actions |
| `@unitn-asa/pddl-client` | `1.6.2` | Online PDDL solver |
| `dotenv` | `^17.4.2` | Loading `.env` |
| `openai` | `^4.104.0` | Client for the OpenAI-compatible endpoint used by the LLM agent |