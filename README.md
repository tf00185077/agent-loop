# auto-agent

auto-agent is a goal-driven agent dashboard and runtime.

The intended product flow is:

1. A user creates a goal in the dashboard.
2. The backend stores the goal and starts an agent run.
3. The agent loop plans, executes, observes, and updates progress.
4. The dashboard shows goal status, run state, steps, and event history.

This repository is currently in the architecture cleanup stage. The previous GitHub Copilot `gh` login, local chat proxy, CLI demo, and static chat dashboard prototype have been removed so the next implementation can start from the goal-centric design.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the current MVP design.

Target shape:

```text
React/Vite Dashboard
        |
        | REST API
        v
Express Backend API
        |
        | reads/writes
        v
SQLite State Store
        |
        | starts
        v
In-process Agent Loop
        |
        | calls
        v
Model Provider Adapter
```

## MVP Scope

The first implementation should focus on:

- Goal CRUD.
- SQLite persistence.
- Single-agent in-process loop.
- Event timeline.
- Dashboard goal list and detail views.
- Provider adapter boundary.

The project should not reintroduce the old chat-first or GitHub Copilot login-first flow as the main architecture.

## Current Status

Implemented:

- Architecture document.
- Cleaned project shell for the new goal-centric implementation.

Not implemented yet:

- Backend API.
- SQLite schema.
- Agent loop.
- React/Vite dashboard.
- Provider adapter.
