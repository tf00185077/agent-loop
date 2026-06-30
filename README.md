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

## Codex Local Provider Setup

The dashboard can run new goals through either the default mock provider or a
local Codex CLI-backed provider. Open the dashboard and use **Provider setup**
before starting a goal.

1. Keep **Mock** selected for deterministic local development with no model
   access.
2. Select **Codex Local** to use the local Codex CLI path.
3. Click **Detect** to look for a Codex CLI command, or enter the command path
   manually if detection reports `Codex CLI not found`.
4. Pick a model from the **Model** dropdown. The picker is populated from the
   local Codex CLI model catalog (discovered via `codex debug models`) and is
   ordered by priority. Use **Refresh models** to reload the catalog after
   detection or after logging in.
   - Leave the model on **Codex CLI default** (blank) to let Codex CLI choose
     its own default model. This is the recommended setting if a specific model
     fails to connect.
   - Selectable models come from the catalog only; there is no free-form manual
     model entry. If the catalog lookup fails, provider setup shows the error
     (including the raw Codex CLI output) and you can fix the command path, run
     Detect, and Refresh models.
   - Existing setups saved with the legacy `gpt-5-codex-subscription` label keep
     working: that label is read back unchanged and is never forced as a Codex
     CLI `--model` argument. Replace it with a catalog model or the Codex CLI
     default when convenient.
5. Click **Save** to persist the selected provider, model slug (or blank for the
   Codex CLI default), command path, and sanitized status metadata in the local
   SQLite database.
6. Click **Test connection** to run a short backend connection check through
   the Codex Local wrapper.
7. Start a draft goal. The backend reads the saved provider settings at goal
   start time, so changing the provider in the dashboard affects the next run
   without restarting the dev server. When no model is selected, run metadata
   records the model as `codex-default`.

The model catalog is fetched on demand from `GET /api/provider-settings/models`
and is sanitized by the backend: only selectable, visible models are returned
with safe display fields (slug, display name, description, priority). Base
instructions, prompt metadata, hidden entries, and any credential material are
never exposed to the dashboard.

Codex authentication is managed by the Codex CLI, not by auto-agent. If the
dashboard shows `Codex login required`, run this in a terminal and then test the
connection again:

```bash
codex login
```

auto-agent does not implement an OpenAI OAuth flow and does not store Codex
access tokens, `auth.json`, browser cookies, API keys, or subscription
credential material. Provider APIs and the dashboard surface only non-sensitive
settings and sanitized status messages. If a Codex Local command fails, the UI
shows one of the provider states (`Codex CLI detected`, `Codex CLI not found`,
`Codex Local connected`, `Codex login required`, `Network failure`, or
`Command failed`) with short guidance for the next action.

## Direction: Managed Agent Control Plane

Codex is the first reference adapter for early development because it is the
most concrete local provider available right now. This is a convergence choice,
not the final product boundary: auto-agent should keep a provider adapter model
so other commercial model adapters can be added after the core workflow is
stable.

The current direction is split across two OpenSpec changes:

- `add-managed-delegation-continuations` defines the product/control-plane
  behavior for supervised child agents.
- `harden-codex-managed-runtime` strengthens the Codex adapter using lessons
  from Paperclip-style Codex execution.

Direction anchors:

- The backend owns spawn, workspace creation, persistence, merge checkpoints,
  and other side effects. Agents emit structured intent; the backend decides
  whether and how to execute it.
- The v1 delegation transport can be a tool-shaped structured control block in
  provider output. It should map cleanly to MCP/tool/API transport later, but
  the first version does not depend on Codex exposing stable custom tools.
- v1 allows one active child at a time and maximum depth one.
- `worker` children run in an isolated git worktree with read/write access only
  inside that worktree.
- Child success, failure, timeout, and cancellation return to the supervisor as
  observations. They do not automatically fail the parent goal.
- If the supervisor is cancelled or terminal while a child is running, the child
  is allowed to finish; late results are stored as detached/ignored instead of
  force-cancelling a process that may be writing files.
- The supervisor decides when to spawn a dedicated `review_merge` child.
- `review_merge` may apply/revert changes in the supervisor workspace, must run
  the configured fixed test command, and reports explicit outcomes such as
  `merged`, `conflict`, `test_failed_reverted`, or `verification_failed`.
- Paperclip is a reference for robust Codex session handling, resume fallback,
  managed runtime home, JSONL parsing, and diagnostics. auto-agent should not
  copy Paperclip's broader organization/remote workspace model until the local
  goal-driven control plane needs it.

### Post-MVP Priority Todo

After the MVP supervisor/child/review-merge loop works end to end, revisit
these items in roughly this order:

- Reintroduce a focused multi-agent run tree change once the MVP has real
  parent/child session records. Start with the single-child/depth-one case,
  then add parallel children and nested relationships later.
- Expand live status beyond the MVP summary to include rich stalled detection,
  current command/task tracking, streamed/SSE updates, and browser verification
  for long-running provider runs.
- Harden Codex runtime isolation with managed `CODEX_HOME`, output inactivity
  diagnostics, usage parsing, optional search/reasoning/extra-argument support,
  and Paperclip-style runtime environment controls.
- Revisit delegated authority/approval as a separate post-MVP capability for
  just-in-time permission grants, user approve/reject flows, and
  restart-as-continuation after authority approval.
- Explore true MCP/tool transport for delegation control events once the
  structured-control-block MVP is stable across providers.

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
