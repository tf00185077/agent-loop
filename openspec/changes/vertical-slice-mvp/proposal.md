## Why

The project has a clear goal-centric domain model, but it still needs a thin working path that proves the product direction end to end. This change creates a dashboard-visible vertical slice so the team can validate the full lifecycle without expanding into real provider behavior, multi-agent orchestration, or detailed runtime inspection too early.

## What Changes

- Build a local single-user MVP path where a user can create a goal from the dashboard, start it, and see durable progress in an event timeline.
- Add SQLite-backed persistence for goals, runs, steps, and events, with SQLite as the source of truth.
- Add the minimal backend REST API needed by the first dashboard demo path:
  - `POST /api/goals`
  - `GET /api/goals`
  - `GET /api/goals/:id`
  - `POST /api/goals/:id/start`
  - `GET /api/goals/:id/events`
- Add a mock in-process runtime that creates a run, records steps and events, and completes or blocks the goal.
- Add a thin React/Vite dashboard with goal list, create goal form, goal detail, start action, and event timeline.
- Keep run and step records persisted, but do not expose dedicated run or step query APIs in the first vertical slice.
- Keep the provider adapter boundary planned, but use mock runtime behavior as the default path for this MVP.
- Explicitly exclude auth, distributed workers, multi-agent orchestration, artifacts, notifications, billing, and polished dashboard UX from this change.

## Capabilities

### New Capabilities

- `dashboard-goal-lifecycle`: Allows the dashboard to create, list, view, and start goals, then show the resulting durable event timeline.
- `goal-state-persistence`: Persists goal, run, step, and event state in SQLite for local durability across refreshes and restarts.
- `mock-agent-runtime`: Runs a mock in-process goal lifecycle that writes durable run, step, and event records without requiring live model credentials.

### Modified Capabilities

None.

## Impact

- Adds backend API, persistence, runtime, and dashboard implementation layers around the existing `src/domain` contracts.
- Introduces SQLite runtime storage, likely under a configurable local path such as `data/auto-agent.sqlite`.
- Introduces backend and frontend dependencies for Express, SQLite access, testing, React, and Vite.
- Establishes event timeline reads as the dashboard's first observability surface instead of exposing detailed run or step query APIs in the initial MVP.
- Keeps provider credentials and runtime behavior on the backend side; the dashboard only communicates through REST API calls.
