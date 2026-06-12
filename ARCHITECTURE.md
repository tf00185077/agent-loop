# auto-agent Architecture

## Purpose

auto-agent is a goal-driven agent dashboard. A user creates a goal in the dashboard, the backend persists it, and an agent loop works toward the goal until it is completed, blocked, failed, cancelled, or waiting for user input.

The product should not be centered on one-off chat. Chat may appear inside a run as agent messages, but the primary object is the goal.

## Architecture Direction

The MVP architecture is:

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

The first version should optimize for a working local single-user product, not a distributed platform. The architecture should keep clean boundaries for future expansion, but only the MVP loop should be implemented first.

## Current Server Decision

The existing server shape was designed around a GitHub Copilot/local `gh` flow and a chat-style dashboard. That is no longer the target architecture.

The formal backend should not be a Copilot token proxy or chat SSE server. It should become the auto-agent backend API:

- Own goal, run, step, and event state.
- Start and supervise agent loops.
- Expose dashboard-facing REST endpoints.
- Keep provider credentials on the backend side.

The current `/api/auth`, `/api/models`, and `/api/chat` style endpoints should not be part of the long-term public API. They can be removed when the backend API and dashboard are rebuilt around goals.

## Core Domain Model

### Goal

A goal is the top-level user intent.

Required MVP fields:

- `id`
- `title`
- `description`
- `status`
- `priority`
- `agentType`
- `createdAt`
- `updatedAt`
- `startedAt`
- `completedAt`

Goal statuses:

```text
draft
running
waiting_user
blocked
completed
failed
cancelled
```

### Run

A run is one attempt to execute a goal. A goal may eventually have multiple runs, but the MVP can start with one active run per goal.

Required MVP fields:

- `id`
- `goalId`
- `status`
- `model`
- `provider`
- `startedAt`
- `finishedAt`
- `error`

Run statuses:

```text
queued
running
completed
failed
cancelled
```

### Step

A step is one unit of work inside a run.

Required MVP fields:

- `id`
- `goalId`
- `runId`
- `title`
- `description`
- `status`
- `order`
- `result`
- `createdAt`
- `updatedAt`

Step statuses:

```text
pending
running
completed
failed
skipped
```

### Event

Events are the durable timeline shown in the dashboard. The dashboard should depend on events for observability instead of reading internal runtime details.

Required MVP fields:

- `id`
- `goalId`
- `runId`
- `stepId`
- `type`
- `message`
- `data`
- `createdAt`

Core event types:

```text
goal.created
run.started
step.started
agent.message
step.completed
run.completed
goal.completed
goal.blocked
error
```

## Backend API

The dashboard should only communicate with the backend through API calls.

MVP endpoints:

```text
POST /api/goals
GET /api/goals
GET /api/goals/:id
POST /api/goals/:id/start
POST /api/goals/:id/pause
GET /api/goals/:id/events
GET /api/runs/:id
```

API responsibilities:

- Validate dashboard input.
- Persist state changes.
- Start or update in-process agent loops.
- Return durable state from SQLite.
- Never require the dashboard to know provider credentials.

## Dashboard

The dashboard should be a goal operations surface, not a chat page.

MVP views:

- Goal list
- Create goal form
- Goal detail
- Current run status
- Step list
- Event timeline

The dashboard should not:

- Store provider API keys.
- Handle GitHub login.
- Directly call model providers.
- Own agent loop state.

## Persistence

MVP persistence should use SQLite.

Reasons:

- Durable local state.
- Simple deployment.
- Clear schema.
- Easier migration path to Postgres than JSON files.

The database path should be configurable, with a default such as:

```text
data/auto-agent.sqlite
```

SQLite is the system of record for goal, run, step, and event state. In-memory runtime state can exist only as a short-lived execution detail.

## Agent Runtime

The MVP runtime should be an in-process loop inside the backend server.

First version constraints:

- Single-user.
- Single goal can be started from the dashboard.
- Single agent loop per active goal.
- No distributed worker.
- No queue system.
- No multi-agent orchestration.

Loop responsibilities:

1. Load the goal.
2. Create a run.
3. Create or update steps.
4. Call the model provider through the provider adapter.
5. Write agent messages and step results as events.
6. Mark the goal as completed, blocked, failed, or waiting for user input.

The loop should always write durable events before and after meaningful actions.

## Provider Adapter

The runtime should not depend directly on a single model provider.

The backend should define a provider boundary similar to:

```ts
interface ModelProvider {
  complete(input: ProviderInput): Promise<ProviderOutput>;
}
```

MVP provider options:

- OpenAI-compatible API provider.
- GitHub Copilot provider.
- Mock provider for tests and local development.

Provider configuration should come from backend environment variables, for example:

```text
AUTO_AGENT_PROVIDER=openai-compatible
AUTO_AGENT_BASE_URL=https://api.openai.com/v1
AUTO_AGENT_API_KEY=...
AUTO_AGENT_MODEL=...
```

The exact provider implementation can evolve, but dashboard code must not depend on it.

## Feature Layering

### MVP

Implement first:

- Goal CRUD.
- Start and pause goal.
- SQLite state.
- Single-agent in-process loop.
- Event timeline.
- Dashboard goal list and detail views.
- Basic provider adapter.
- Completed, blocked, failed, and cancelled lifecycle.

### Extension Points

Plan for these, but do not fully implement in the first version:

- Multi-agent orchestration.
- Human approval checkpoints.
- Tool permissions.
- Artifacts.
- Memory and goal context.
- Notifications.
- Reviewer agent.
- Worker process.

### Future Roadmap

Do not design in detail yet:

- Distributed queue.
- Multi-user auth.
- Plugin system.
- Advanced observability.
- Cost tracking.
- Team dashboard.

## Testing Strategy

API tests:

- Creating a goal persists it.
- Listing goals returns persisted goals.
- Reading one goal returns current status and metadata.
- Starting a goal creates a run and changes goal status.
- Event timeline can be read after a page refresh or server restart.

Runtime tests:

- Provider adapter can be mocked.
- Agent loop writes run, step, and event records.
- Provider failure creates an `error` event.
- Failed runtime updates goal and run status.

Dashboard tests:

- User can create a goal.
- Goal list shows current statuses.
- Goal detail shows events.
- Refreshing the browser keeps state visible.

## Implementation Order

Recommended order:

1. Replace the old server concept with backend API boundaries.
2. Add SQLite persistence and schema.
3. Implement goal API endpoints.
4. Add provider adapter with a mock provider first.
5. Implement the single-agent in-process loop.
6. Replace the dashboard with React/Vite goal views.
7. Add tests around API, runtime loop, and dashboard behavior.

## Non-Goals For MVP

The MVP should not include:

- Multi-user authentication.
- Complex permission policy.
- Distributed execution.
- Multiple concurrent workers.
- Full artifact management.
- Full notification system.
- Complete Git workflow automation.
- Billing or token-cost accounting.

These can be added later after the single-goal loop is useful and observable.
