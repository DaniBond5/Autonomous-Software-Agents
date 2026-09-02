# Autonomous Software Agents - Deliveroo.js

**Course:** Autonomous Software Agents, University of Trento
**Authors:** Daniele Buondonno (267888), Sasha Petkovic (264689)  
**Report:** [Report](docs/Report%20Buondonno-Petkovic.pdf)

## Overview

This project implements a team of two autonomous agents for the Deliveroo.js environment. Both agents use the same BDI-based core for autonomous parcel collection, delivery, exploration and planning. Agent B additionally includes an LLM layer that interprets natural-language missions, creates BDI objectives and adapts persistent strategies, while physical execution remains under BDI control.

The BDI control cycle is:

1. Sense the environment and revise beliefs.
2. Generate and evaluate desires.
3. Revise the current intention.
4. Plan the next action.
5. Execute the action and repeat.

At a high level, the system combines utility-based BDI deliberation, BFS for ordinary navigation, PDDL when crate manipulation is required, and direct coordination between the two agents.

LLM missions are handled one at a time. If a new request arrives while another mission is running, it receives an immediate busy reply.

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
│   ├── Report Buondonno-Petkovic.tex
│   └── Report Buondonno-Petkovic.pdf
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
    │   └── rules.js           # persistent strategy rules used by BDI deliberation and planning
    ├── llm/
    │   ├── client.js          # OpenAI-compatible model client
    │   ├── core.js            # mission lifecycle and busy-state handling
    │   ├── memory.js          # compact mission context built from current BDI state
    │   ├── planner.js         # LLM execution loop
    │   ├── replanner.js       # requests another approach after a semantic failure
    │   └── executor.js        # tool registry and structured tool results
    ├── pddl/
    │   ├── crate-planner.js   # PDDL client used when crates block normal routes
    │   └── crates-domain.pddl # crate movement domain
    └── utils/
        ├── geometry.js        # BFS and grid geometry helpers
        └── trace.js           # optional structured execution tracing
```
