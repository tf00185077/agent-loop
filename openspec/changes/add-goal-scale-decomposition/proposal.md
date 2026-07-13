# Proposal: add-goal-scale-decomposition

## Why

A goal like "build a shooter game with 4v4 and co-op modes" is too large for one flat task list: the supervisor cannot hold thirty tasks' worth of cross-task consistency in a context window, task contracts are amnesiac between tasks, and nothing today records the durable product truth that later tasks must not contradict. The proven fix shape is a middle tier: the supervisor splits an oversized goal into ordered OpenSpec changes; per-change spec artifacts become the cross-task contract; and the existing task-acceptance machinery executes each change. Critically, no agent operates the OpenSpec workflow: agents emit structured intent and author markdown content, while the backend owns scaffolding, structural validation (the `openspec` CLI as a backend validator), sequencing, and archiving.

## What Changes

- Add a `managed_change.plan` control block: the supervisor declares an ordered list of changes (`{id, title, rationale, dependsOn}`) after assessing goal scale; the bootstrap contract documents scale-assessment triggers (proof-obligation and size budgets from staged-delivery practice). Small goals keep today's single task-list flow unchanged.
- Backend materializes each planned change as OpenSpec-shaped artifacts in the goal workspace, detects the `openspec` CLI with the existing reusable CLI-detection machinery, and runs `openspec validate --strict` as a deterministic acceptance gate — with a durable `runtime.openspec_unavailable` downgrade (backend-rendered markdown, internal validation only) when the CLI is missing.
- Spec authoring is itself a contracted worker delegation: accepting a change plan registers one synthetic spec-writing task per change with machine-verifiable frozen criteria (validate passes, every requirement has a WHEN/THEN scenario, every task carries acceptance criteria). Spec-writer workers run in worktrees like any worker and their artifacts reach the goal workspace only through the review-merge gate.
- Enforce change sequencing in the control plane: exactly one active change at a time, in `dependsOn` order; task lists and worker delegations reference their `changeId`; deterministic plan budgets (max changes per plan, max tasks per change, acyclic `dependsOn`) are backend validators.
- Change completion is gated: all of the change's tasks done, and — when workers produced attested file changes — a successful `review_merge` outcome for them; the backend then archives the change (`openspec archive` or the degraded equivalent). `managed_delegation.complete` is rejected while planned changes remain unarchived.
- Continuation prompts extend the durable history with change-level state (which change is active, archived, blocked) alongside the existing task history.

## Capabilities

### New Capabilities

- `goal-scale-decomposition`: The change-plan control block and budgets, backend OpenSpec materialization/validation/archiving with CLI detection and visible degradation, contracted spec-writer delegations, one-active-change sequencing, and merged-evidence change completion.

### Modified Capabilities

- `supervisor-goal-orchestration`: The bootstrap contract SHALL document scale assessment and the change-plan format; task decomposition SHALL reference the active change when a plan exists; goal completion SHALL additionally require all planned changes archived; continuations SHALL carry change-level history.
- `managed-delegation-core`: Delegation requests and task lists SHALL carry an optional `changeId`; the one-active-child rule gains a one-active-change sibling at the plan level.

## Impact

- **Domain**: `managed_change.plan` control event, change plan/record types, `changeId` on task-list entries and delegation requests.
- **Runtime**: control-event validation; a change registry beside the task registry in the session manager; an OpenSpec materializer/validator service (CLI detection via `cli-command-detection`, scaffold/write/validate/archive, degradation); spec-writer synthetic task registration and prompt appendix (artifact templates — not the OpenSpec skill); sequencing and completion gates.
- **Persistence**: additive `change_id` column on delegation requests; change plans and transitions ride durable events (no new table in v1).
- **Prompts**: supervisor contract sections for scale assessment and change plans; change history in continuations; spec-writer appendix with proposal/specs/tasks templates.
- **Dashboard**: no new UI; events carry `changeId` metadata (feeds `add-agent-live-status-model` later).
- **Non-goals**: parallel changes or children, nested delegation, quorum review of spec content (structural validation only in v1), workspace-less goals getting OpenSpec artifacts (degrade to events), owner-remediation loops.
