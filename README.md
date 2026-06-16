# auto-agent

auto-agent is a goal-driven agent dashboard and runtime.

The product flow is:

1. A user creates a goal in the dashboard.
2. The backend stores the goal and starts an agent run.
3. The agent loop plans, executes, observes, and records progress as durable events.
4. The dashboard shows goal status and the event timeline.

The first vertical slice (`vertical-slice-mvp`) is implemented as a thin,
local, single-user path: React/Vite dashboard → Express API → SQLite →
in-process **mock** runtime. The mock runtime proves the lifecycle and the
event-based observability surface before real model providers are wired in.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

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
In-process Mock Runtime
```

The layers live under [src/](./src):

- `src/domain` — framework-agnostic shared types (goals, runs, steps, events).
- `src/persistence` — SQLite connection, schema, and repositories.
- `src/runtime` — in-process mock agent runtime.
- `src/backend` — Express API (`createApp`) and dev server.
- `src/dashboard` — React/Vite dashboard.

## Local Setup

Requirements: Node.js `>=20.19.0`.

```bash
npm install
cp .env.example .env   # optional; defaults work out of the box
```

State is persisted to SQLite at `data/auto-agent.sqlite` by default. Override
with `AUTO_AGENT_DB_PATH`.

## Run Commands

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Runs the backend API and dashboard dev server together.             |
| `npm run dev:api`   | Backend only, on `http://localhost:3001` (override with `PORT`).    |
| `npm run dev:web`   | Dashboard only (Vite dev server, proxies `/api` to the backend).    |
| `npm run typecheck` | Type-checks the project with `tsc --noEmit`.                        |
| `npm test`          | Runs the Node test runner across `src/**/*.test.ts`.                |

For local development, run `npm run dev` and open the Vite URL it prints
(default `http://localhost:5173`).

## MVP Demo Path

1. Start the app: `npm run dev`.
2. In the dashboard, create a goal with a title and description.
3. The new goal appears in the goal list with status `draft`.
4. Open the goal detail and click **Start**. The goal moves to `running`,
   and the mock runtime records a run, mock steps, and lifecycle events.
5. Watch the **event timeline** fill in: `goal.created`, `run.started`,
   `step.started` / `agent.message` / `step.completed` per step,
   `run.completed`, and finally `goal.completed`.
6. Refresh the browser — the goal and its full timeline are still there,
   because SQLite is the durable source of truth.

Tip: creating a goal whose title starts with `block` exercises the
deterministic blocked path, ending in a `goal.blocked` event.

### MVP API

The first slice exposes only the endpoints the demo path needs:

- `POST /api/goals` — create a goal.
- `GET /api/goals` — list goals.
- `GET /api/goals/:id` — goal detail snapshot.
- `POST /api/goals/:id/start` — start the mock runtime for a draft goal.
- `GET /api/goals/:id/events` — durable event timeline.

Runs and steps are persisted but intentionally have **no** dedicated query
APIs in this slice — the event timeline is the observability surface.

## Scope

In scope for the MVP: goal create/list/detail/start, SQLite persistence,
in-process mock runtime, and the event timeline.

Out of scope (intentionally deferred): auth, real model providers, multi-agent
orchestration, distributed workers, pause/cancel/retry/resume, dedicated run or
step query APIs, artifacts, notifications, billing, and polished dashboard UX.
