# Autonomous-Software-Agents

A project focused on the design and implementation of autonomous software agents for parcel delivery in the Deliveroo.js environment, developed for the Autonomous Software Agents course at the University of Trento.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6%2B-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![PDDL](https://img.shields.io/badge/PDDL-Planning-blue.svg)](https://planning.wiki/)

**Course:** Autonomous Software Agents  
**Institution:** University of Trento

---

## Overview

This project develops autonomous software agents for the Deliveroo.js environment.

The project combines reactive decision-making, shortest-path navigation, and automated planning to handle ordinary routes, dynamic obstacles, directional tiles, and movable crates.

## Main Features

- Belief-Desire-Intention architecture
- Dynamic belief updates from Deliveroo.js sensing events
- Utility-based pickup, delivery, and exploration decisions
- Persistent intention selection and revision
- BFS shortest-path navigation
- Directional tile support
- Temporary obstacle and collision handling
- PDDL planning for routes blocked by movable crates
- Validation of move and push actions
- Execution of move, pickup, and putdown actions
- Belief reconciliation after server acknowledgements
- Configurable runtime logging

## Prerequisites

- Node.js 18 or newer
- npm
- A running Deliveroo.js server
- A valid Deliveroo.js agent token
- Internet access for the online PDDL solver

## Setup

Clone the repository:

```bash
git clone https://github.com/SashaPetkovic/Autonomous-Software-Agents.git
cd Autonomous-Software-Agents
```

Install the dependencies:

```bash
npm ci
```

Create the local environment file:

```bash
cp .env.example .env
```

Configure the required values:

```env
HOST=http://localhost:8080
TOKEN=replace_with_bdi_agent_token
LLM_TOKEN=
```

- `HOST` is the Deliveroo.js server address.
- `TOKEN` is the authentication token used by the BDI agent.
- `LLM_TOKEN` is reserved for the future LLM-based agent.

Do not commit the `.env` file.

## Deliveroo.js Server

By default, the agent connects to:

```text
http://localhost:8080
```

The server must be started separately by following the instructions in the [Deliveroo.js repository](https://github.com/unitn-ASA/Deliveroo.js).

## PDDL Solver

When movable crates block an ordinary BFS route, the agent calls `onlineSolver` from `@unitn-asa/pddl-client`. The domain and the generated problem are sent over the network and the plan comes back from that remote service, so no planner has to be installed on the machine running the agent, but internet access is required.

In the code and in the log messages, `local` and `global` describe the scope of the problem handed to that same remote solver, not where it runs: `local` covers only the crate corridor between an entry and an exit tile, `global` covers the whole map.

The PDDL domain is stored in:

```text
src/pddl/crates-domain.pddl
```

## Running the Agent

Start the BDI agent with:

```bash
npm start
```

This command runs:

```bash
node src/agent.js
```

## Repository Structure

```text
.
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── README.md
└── src/
    ├── agent.js
    ├── config.js
    ├── bdi/
    │   ├── beliefs.js
    │   ├── desires.js
    │   ├── execution.js
    │   ├── intentions.js
    │   └── planning.js
    ├── pddl/
    │   ├── crate-planner.js
    │   └── crates-domain.pddl
    └── utils/
        └── geometry.js
```

## Main Dependencies

| Package | Version | Purpose |
|---|---:|---|
| `@unitn-asa/deliveroo-js-sdk` | `^1.3.10` | Deliveroo.js connection and actions |
| `@unitn-asa/pddl-client` | `1.6.2` | Online PDDL planning |
| `dotenv` | `^17.4.2` | Loading local environment variables |