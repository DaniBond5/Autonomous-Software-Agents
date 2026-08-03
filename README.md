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
LLM_TOKEN=
```

`LLM_TOKEN` is the second agent's own token, so the two play as two players. Leave it empty
to run the BDI agent alone.

`.env` is ignored by git and must not be committed.

## Running

One file starts the program, and an argument says which agents play:

```bash
npm start          # the BDI agent alone
npm run start:llm  # the LLM agent alone
npm run start:both # both together, in one process
```

Open the server address in a browser with the same token to watch an agent play from its
own point of view.

The first two run one agent with no teammate, which is the baseline the pair is compared
against. Each connects only its own token, so a `.env` holding one of the two is enough.

`npm run start:both` is the only mode in which the agents coordinate: it connects both
tokens, gives each agent the other's id, and prints one line saying which id each of them
got. Their log lines are prefixed with the name on their token, so `[bdi]` and `[llm]` tell
the two apart.

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
    ├── main.js               # the entry point: starts one agent or both, and introduces them
    ├── bdi-agent.js          # builds the BDI agent on a socket
    ├── llm-agent.js          # builds the LLM agent, and handles its chat
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