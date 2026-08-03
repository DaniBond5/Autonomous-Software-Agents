# Autonomous Software Agents - Deliveroo.js

**Course:** Autonomous Software Agents - University of Trento

**Authors:** Sasha Petkovic (sasha.petkovic@studenti.unitn.it, 264689), Daniele Buondonno (daniele.buondonno@studenti.unitn.it, 267888)

**Report:** 

## Overview

This project runs autonomous agents in Deliveroo.js. The agents collect parcels, avoid
obstacles, coordinate with a teammate and deliver parcels for points.

The normal control cycle follows a BDI (Belief-Desire-Intention) architecture:

1. Beliefs store the current agent, parcels, map, crates, other agents and teammate state.
2. Desires generate and score the goals that can currently be pursued.
3. Intention revision selects or keeps one goal.
4. The planner produces one next action using BFS, or PDDL when movable crates block the route.
5. The executor sends the physical action.
The control loop reconciles the real server result with the beliefs and planner state.

The LLM agent uses the same BDI control cycle. Chat missions enter an **LLM execution loop**
that selects tools and reads their observations. Physical tools create BDI objectives; only
the BDI executor sends move, pickup and putdown actions to the server. Missions run one at a
time, with at most one latest pending mission. A semantic tool failure gives the replanner one
concrete reason, so the next LLM turn can choose another approach.

### Live LLM context

Each LLM turn rebuilds its context from live beliefs. It includes:

- the agent position, score and carried parcels;
- known parcels and delivery tiles;
- the active Level 2 strategy;
- the partner's last reported position and carried load.

Each agent shares its position and load only when they change. The LLM reads this state
directly from its context instead of asking for it again.

### Persistent strategy adaptation

The LLM agent can install persistent strategies for stack size, delivery tiles, parcel values,
and avoided tiles. A strategy can apply to one agent or both agents and remains active until it
is replaced or cleared.

## Installation

### Requirements

- Node.js 18 or newer and npm
- A running Deliveroo.js server
- One Deliveroo.js token for each agent you want to run
- An OpenAI-compatible endpoint when running the LLM agent
- Internet access when the online PDDL solver or a remote LLM endpoint is used

### Install the project

Clone the repository and install the pinned dependencies:

```bash
git clone https://github.com/DaniBond5/Autonomous-Software-Agents.git
cd Autonomous-Software-Agents
npm ci
```

### Start a Deliveroo.js server

Follow the [Deliveroo.js repository](https://github.com/unitn-ASA/Deliveroo.js) instructions,
or start a local server with:

```bash
git clone https://github.com/unitn-ASA/Deliveroo.js.git
cd Deliveroo.js
npm install
npm run build
npm start
```

The default local address is `http://localhost:8080`. Open it in a browser, create a player
and copy its token. Create a second player with a different name and token when running both
agents.

### Configure the environment

Create the local environment file:

```bash
cp .env.example .env
```

Fill in the values needed by the modes you plan to run:

```env
HOST=http://localhost:8080

# BDI agent token
TOKEN=replace_with_bdi_agent_token

# LLM agent token
LLM_TOKEN=replace_with_llm_agent_token

# OpenAI-compatible endpoint
LITELLM_BASE_URL=https://llm.bears.disi.unitn.it/v1
LITELLM_API_KEY=replace_with_api_key
LOCAL_MODEL=llama-3.3-70b-lmstudio

# Optional player name or id allowed to send LLM missions
MISSION_SENDER=
```

`TOKEN` is required for the BDI agent. `LLM_TOKEN` and the LiteLLM settings are required for
the LLM agent. Leave `MISSION_SENDER` empty to accept missions from any non-partner player.
The `.env` file is ignored by Git and must not be committed.

## Running

Run one agent or the coordinated pair:

```bash
npm start          # BDI agent only
npm run start:llm  # LLM agent only
npm run start:both # BDI and LLM agents in one process
```

| Command | Required configuration | Behaviour |
|---|---|---|
| `npm start` | `HOST`, `TOKEN` | Runs the autonomous BDI agent. |
| `npm run start:llm` | `HOST`, `LLM_TOKEN`, LiteLLM settings | Runs the LLM agent with its BDI loop. |
| `npm run start:both` | Both tokens and LiteLLM settings | Runs both agents and connects them as teammates. |

When both agents run, their log lines use their Deliveroo.js names and the launcher prints
the two assigned agent IDs. Open the Deliveroo.js server in a browser with an agent token to
watch that agent play.

## Repository structure

```text
.
├── .env.example               # environment variable template
├── docs/
│   ├── Report Buondonno-Pektovic.tex
│   └── Report Buondonno-Pektovic.pdf
├── package.json               # dependencies and start commands
├── package-lock.json          # pinned dependency versions
├── README.md
└── src/
    ├── main.js                # starts one agent or the coordinated pair
    ├── config.js              # reads environment and runtime settings
    ├── bdi-agent.js           # builds the standalone BDI agent
    ├── llm-agent.js           # builds the LLM agent and receives chat missions
    ├── bdi/
    │   ├── beliefs.js         # agent, parcels, crates, map and partner beliefs
    │   ├── desires.js         # candidate goals and utility calculation
    │   ├── intentions.js      # intention selection and revision
    │   ├── planning.js        # BDI planner and plan library
    │   ├── execution.js       # only physical socket actuator
    │   ├── loop.js            # shared BDI control loop
    │   ├── objectives.js      # physical objectives requested by the LLM
    │   └── rules.js           # Level 2 strategy policies and temporary hold
    ├── llm/
    │   ├── client.js          # OpenAI-compatible model client
    │   ├── core.js            # active and latest-pending mission lifecycle
    │   ├── memory.js          # mission context and one pending replan reason
    │   ├── planner.js         # LLM execution loop
    │   ├── replanner.js       # requests another approach after a semantic failure
    │   └── executor.js        # tool registry and structured tool results
    ├── pddl/
    │   ├── crate-planner.js   # PDDL client used when crates block normal routes
    │   └── crates-domain.pddl # crate movement domain
    └── utils/
        └── geometry.js        # BFS and grid geometry helpers
```
