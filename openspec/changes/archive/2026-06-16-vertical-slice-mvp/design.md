## Context

auto-agent currently has goal-centric architecture documentation and framework-agnostic TypeScript domain types, but no working backend, persistence, runtime, or dashboard. The next useful milestone is a thin dashboard-visible vertical slice that proves the core product loop without expanding into real autonomous agent behavior or detailed runtime inspection.

The MVP demo path is: create a goal in the dashboard, start it, let a mock backend runtime write durable progress, and show the resulting event timeline in the dashboard after refresh. The dashboard should understand goal snapshots and events first; run and step details remain persisted backend/runtime state until a later change needs explicit UI around them.

## Goals / Non-Goals

**Goals:**

- Establish a local single-user vertical slice across React/Vite dashboard, Express API, SQLite persistence, and an in-process mock runtime.
- Persist goals, runs, steps, and events in SQLite so refreshes and server restarts do not erase visible progress.
- Expose only the REST endpoints required for the first dashboard demo path:
  - `POST /api/goals`
  - `GET /api/goals`
  - `GET /api/goals/:id`
  - `POST /api/goals/:id/start`
  - `GET /api/goals/:id/events`
- Use the event timeline as the dashboard's primary observability surface.
- Keep provider credentials and runtime behavior behind the backend boundary.

**Non-Goals:**

- Dedicated run or step query APIs such as `GET /api/runs/:id` or `GET /api/goals/:id/steps`.
- Pause, cancel, retry, or resume behavior.
- Real model provider quality, tool use, multi-agent orchestration, distributed workers, auth, permissions, artifacts, notifications, billing, or polished dashboard UX.

## Decisions

1. **Build the dashboard MVP as one thin vertical slice.**

   The alternative is to complete the backend first and add the dashboard later. That is safer technically but delays product feedback. The selected approach keeps each layer narrow so the full product loop becomes visible early.

2. **Use SQLite as the durable source of truth for all lifecycle entities.**

   Goals, runs, steps, and events will be stored even if the first dashboard only reads goals and events. The alternative is to start with in-memory or JSON storage, but that would fail the refresh/restart confidence the MVP needs.

3. **Keep the first public API focused on goal snapshots and events.**

   The dashboard needs to create goals, list goals, read one goal, start a goal, and read that goal's event timeline. Dedicated run and step reads are intentionally deferred because they would force the first UI to understand more runtime state than needed to prove the lifecycle.

4. **Use a mock in-process runtime first.**

   The mock runtime creates the run, records steps and events, and resolves the goal to a terminal state. This proves lifecycle and observability before live provider credentials, prompts, and model variability enter the system.

5. **Treat events as the first observability contract.**

   Runtime-visible actions write events before and after meaningful work. The dashboard should show what happened through the event stream instead of reaching into internal runtime state.

## Risks / Trade-offs

- **Risk: The MVP hides run and step details too aggressively.** -> Mitigation: Persist run and step records now, but add dedicated query APIs only when a later UI requires them.
- **Risk: Mock runtime gives a false sense of agent capability.** -> Mitigation: Name it clearly as mock behavior and keep provider integration as a later boundary-focused phase.
- **Risk: Building dashboard and backend together increases scope.** -> Mitigation: Keep the dashboard thin and avoid settings, auth, provider configuration, polished UI, and detailed runtime views.
- **Risk: Event timeline can become underspecified.** -> Mitigation: Require meaningful events for goal creation, run start, step start/completion, agent messages, terminal success, blocked state, and errors.

