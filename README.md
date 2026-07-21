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

The managed supervisor loop is implemented by the
`wire-managed-supervisor-end-to-end` change (see `openspec/changes/`), building
on the archived `add-managed-delegation-core` and `harden-codex-managed-runtime`
changes.

### Managed Supervisor Flow

Starting a `codex-local` (or `claude-local`) goal now runs a managed supervisor
session by default:

1. The backend builds a supervisor bootstrap prompt from the goal: decompose
   into an ordered task list first, delegate exactly one `worker` task at a
   time, request a `review_merge` child after workers that changed files, and
   signal completion explicitly.
2. The supervisor communicates control intent through fenced
   ` ```auto-agent-control ` JSON blocks in its output:
   `managed_delegation.task_list`, `managed_delegation.request`, and
   `managed_delegation.complete`. Only fenced blocks are honored; the
   surrounding prose is recorded as sanitized progress.
3. Worker children run in isolated git worktrees. The compatibility role id
   `review_merge` now means an independent Judge: it reads the frozen contract,
   worker evidence, attested files, and candidate diff, then emits a strict
   `managed_review.decision`. It has no apply or commit authority.
4. Child outcomes return to the supervisor as observations. Providers with true
   resume continue in place; others get a fresh continuation prompt that
   re-carries the full contract.
5. A `managed_delegation.complete` block is only a completion request. The
   backend completes the goal only when every durable leaf task is accepted,
   every criterion is `PASS`, no attempt/review/delivery is pending, all
   attested changes are delivered, and planned changes are archived. A
   session that exits without completing (and with no pending delegation)
   triggers a bounded "continue or complete" continuation (default 10 per
   goal); exhausting the bound marks the goal `blocked`.
6. If the installed CLI cannot support managed session mode, the backend
   records a durable `runtime.managed_mode_downgraded` event and falls back to
   the previous one-shot provider run — visible, never silent.

### Conditional Integrator conflict recovery

`review_merge` remains the independent Judge; it does not commit. After an
accepted Worker result, the backend creates and applies the candidate. If that
exact apply produces a verified Git conflict, the backend records one durable
integration attempt and immediately dispatches the optional `integrator` role
in an isolated worktree rooted at the recorded checkpoint. The Integrator may
only resolve the recorded conflict within the backend-computed allowed files;
it may not move `HEAD`, commit, select providers, change acceptance criteria,
or authorize delivery.

The backend verifies the index and file scope, creates the resolved candidate
commit itself, and dispatches a new candidate-bound Judge. Only a decision that
names the exact integration attempt and resolved SHA can authorize the final
fixed validation and commit. Malformed results, unresolved/out-of-scope work,
rejection, interruption, or delivery failure are persisted and handed back to
the Supervisor without starting a second automatic Integrator attempt.

### Role Agent Assignments

The assignable child roles are `worker`, `spec_writer`, `review_merge`, and the
conditional conflict-recovery role `integrator`.

Provider setup can assign a different agent per child role — `worker`,
`spec_writer`, and `review_merge` — each with its own provider, model label,
and optional command path (auto-detected when blank). Roles left on inherit
use the goal's selected provider, which also remains the supervisor's agent.
Assignments are user policy resolved by the backend at dispatch: supervisor
output cannot select providers. If an assigned agent is unavailable or cannot
support managed execution, the backend records a durable
`role_assignment.downgraded` event and the child runs on the goal provider.
Child runs and delegation events record the provider/model that actually
executed each role.

### Task Acceptance Contracts

Every delegated task runs under a frozen acceptance contract, enforced by
backend validators rather than prompt text:

- Task-list entries carry acceptance criteria (`{id, text}` with binary,
  testable conditions). Worker delegations for a known task without a contract
  are rejected; later attempts to rewrite frozen criteria are ignored and
  recorded durably.
- Workers receive the contract as a prompt appendix and report back through a
  `managed_task.result` control block (per-criterion evidence, tests run,
  claimed files). The backend attests changed files from the worker worktree's
  git status — the attested list is authoritative, and claimed-vs-attested
  discrepancies are recorded. Worker evidence remains a claim and never marks
  a criterion `PASS` by itself.
- The Judge must decide every frozen criterion exactly once as `PASS`, `FAIL`,
  or `BLOCKED`. Valid decisions update authoritative SQLite outcomes; malformed
  or uncited objections become durable deferred findings without changing task
  state.
- For accepted file-producing attempts, backend code verifies the attestation,
  creates a runtime-owned candidate commit, checkpoints a clean supervisor
  workspace, cherry-picks the candidate, runs the configured fixed validation,
  and records the commit or verified rollback outcome.
- After two substantive rejections (or three attempts), the backend refuses
  identical-scope retries and requires the supervisor to split the failing
  criteria into strictly narrower tasks with `parentTaskId` lineage — the
  reviewer/coder ping-pong loop is structurally bounded.
- Continuation prompts are projections of durable tasks, attempts, criteria,
  Judge reviews, and deliveries with bounded safe summaries. Raw AI responses
  remain transcript/audit material, not runtime authority.

### Goal-Scale Decomposition (OpenSpec Change Plans)

Oversized goals get a tier above the flat task list: the supervisor assesses
scale at bootstrap and may declare an ordered change plan with a
`managed_change.plan` control block (2–8 changes, unique ids, acyclic
`dependsOn` — budgets enforced by backend validators, one plan per goal).
Small goals skip the plan and keep the flat flow with zero new overhead.

- **Backend-owned OpenSpec.** Accepting a plan scaffolds each change's
  artifacts (`openspec/changes/<id>/`) in the goal workspace from internal
  templates and commits them so child worktrees can see them. The `openspec`
  CLI is a backend validator (strict validate as an acceptance gate, dated
  archive moves); agents never run it. A missing CLI records a durable
  `runtime.openspec_unavailable` downgrade and internal structural checks take
  over — visible, never silent.
- **Spec authoring is a contracted delegation.** Each planned change gets a
  backend-registered `spec:<changeId>` task with frozen S1–S3 criteria
  (validation passes; every requirement has a WHEN/THEN scenario; every task
  carries acceptance criteria). Spec-writer workers get a provider-neutral
  appendix (change context, target paths, filled markdown templates — never
  the OpenSpec CLI workflow), author in their worktree, and their artifacts
  are validated pre-merge; failures become substantive rejections citing the
  failing criteria. Merged artifacts re-validate in the goal workspace before
  the change moves `specifying → executing`.
- **One active change at a time.** Task lists and delegations inherit the
  active `changeId`; explicit mismatches (and tasks owned by an inactive
  change) are rejected naming the active change. Delegation rows persist
  `change_id`.
- **Merged evidence gates archives.** A change archives only when all its
  registered tasks are delivered and no attested worker file changes remain
  unmerged (blocked archives record the missing-merge reason durably).
  Archiving activates the next change; `managed_delegation.complete` is
  rejected while unarchived planned changes remain.
- Continuations render the durable change-plan history (statuses,
  dependencies, the active change) alongside the task history.

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
- `review_merge` is the compatibility transport id for the independent Judge;
  deterministic backend delivery owns apply, fixed validation, commit, and
  rollback and records outcomes such as `committed`, `conflict`,
  `test_failed_reverted`, `revert_failed`, or `verification_failed`.
- Paperclip is a reference for robust Codex session handling, resume fallback,
  managed runtime home, JSONL parsing, and diagnostics. auto-agent should not
  copy Paperclip's broader organization/remote workspace model until the local
  goal-driven control plane needs it.

### Caller Escalation (waiting_user)

Recoverable goal-level bounds no longer terminate the goal. When the
planning-epoch budget is exhausted, the reassessment circuit breaker trips, or
supervisor continuations run out, the backend records a durable structured
input request and parks the goal in the non-terminal `waiting_user` status.
The goal's caller — the dashboard today, an agent client over the same API
later — answers with one machine-validated decision:

- `extend_budget` (integer 1..base) raises the effective budget, derived as
  base + accepted grants and recomputed from durable rows on restart.
- `provide_guidance` injects the caller's text into the resumed supervisor's
  continuation prompt as an observation (budget reasons imply a +1 grant; the
  circuit breaker never offers a bare extension).
- `abandon` blocks the goal terminally with a caller-attributed reason.

Resume is always a fresh supervisor continuation rehydrated from durable
state, so answers work minutes or days later and across backend restarts.
`GET /api/goals/:id/input-request` reads the pending request;
`POST /api/goals/:id/input-request/:requestId/respond` answers it (400
invalid, 404 unknown, 409 already-resolved with the standing resolution).
Unrecoverable failures (archive capability unavailable, lineage-corrupt
recovery) still write terminal `blocked`.

A live supervisor can also **initiate** an escalation: a `managed_goal.request_input`
control block asks the caller one bounded question (reason `supervisor_question`)
when a decision is genuinely the caller's — an ambiguous requirement, a missing
preference — instead of guessing and being second-guessed a loop later. Backend
gates enforce it: no pending request already open, no in-flight child delegation,
a bounded question, and a per-goal question budget (default 3) whose exhaustion
rejects with "decide autonomously and proceed". A question grants no budget.

**Multi-turn conversations and confirmation.** A caller reply to a question or a
plan proposal opens a **read-only conversation**: the backend runs the supervisor
in a turn that may only ask again, revise its proposal (`managed_goal.propose_plan`),
or signal `managed_goal.ready_to_proceed` — work-producing blocks are rejected until
it signals ready. The exchange is one durable message thread on the `waiting_user`
state, so it survives restarts; a conversation-turn budget bounds it. The loop
resumes only when the supervisor is ready (mutual confirmation), though the caller
can `proceed` (force-resume) or `abandon` at any point. Separately, a **caller-owned
`confirmationPolicy`** (per goal, default `off`, opt-in `required`, unreadable and
unchangeable by the supervisor) makes the checkpoint mandatory: under `required` a
worker delegation is rejected unless a standing confirmation exists, forcing the
supervisor to propose and reach `ready_to_proceed` first. A new `managed_change.plan`
clears the confirmation, so each epoch's plan is re-confirmed. The dashboard renders
the thread as a chat with a persistent reply box.

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

- `POST /api/goals` — create a goal. Optional `confirmationPolicy` (`off` |
  `required`) and `workspace` (an absolute path to an existing directory the
  supervisor and its workers run in; validated at creation, defaults to the
  server's working directory). A goal may also run inside the auto-agent repo
  itself: every workspace-cleanliness gate (delivery, integration, review-merge,
  OpenSpec archive, recovery) ignores the runtime's own `data/auto-agent.sqlite`
  (and its `-wal`/`-shm`/`-journal` sidecars), so the runtime's live DB writes are
  not seen as a dirty workspace — any other change still is.
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
