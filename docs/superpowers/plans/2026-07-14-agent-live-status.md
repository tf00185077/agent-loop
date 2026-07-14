# Agent Live Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one compact, durable, pipeline-aware live status to the existing goal agent-session snapshot and dashboard.

**Architecture:** A pure projector consumes sanitized goal, session, approval,
delegation, managed-task, integration, and event read models. Structured records
select state and phase by fixed precedence; events only fill missing bounded
summary/time. The existing backend snapshot returns the projection and the
existing dashboard refresh path renders it.

**Tech Stack:** TypeScript, Node test runner, Express, React server rendering,
SQLite repositories, OpenSpec.

## Global Constraints

- No database schema or new endpoint/SSE protocol.
- No raw prompt, diff, command, diagnostic, provider payload, or credentials.
- Normalize summaries and cap them at 500 characters.
- Terminal goal state overrides every stale lower-level record.
- Use test-first red/green cycles for production behavior.

---

### Task 1: Domain contract and pure projector

**Files:**
- Modify: `src/domain/agent-runtime-control-plane.types.ts`
- Modify: `src/domain/agent-runtime-control-plane.types.test.ts`
- Modify: `src/domain/index.ts`
- Create: `src/runtime/agent-session/agent-live-status.ts`
- Create: `src/runtime/agent-session/agent-live-status.test.ts`

**Interfaces:**
- Produces: `AgentLiveStatus`, `AgentLiveStatusState`,
  `AgentLiveStatusPhase`, and `projectAgentLiveStatus(input)`.
- Consumes: sanitized domain Goal/Event/session/approval/delegation records and
  `ManagedTaskContextRecord[]`.

- [ ] Write domain tests asserting exact state/phase arrays and a complete
  nullable `AgentLiveStatus` fixture.
- [ ] Run `node --import tsx --test src/domain/agent-runtime-control-plane.types.test.ts`
  and confirm the missing exports fail.
- [ ] Add the exact state/phase constants, interface, and index exports.
- [ ] Write projector tests for terminal precedence, approval, waiting input,
  stalled, missing metadata, Worker, Judge, Integrator, re-Judge, delivery,
  continuation, validation, rollback, stale prose, and 500-character bounds.
- [ ] Run `node --import tsx --test src/runtime/agent-session/agent-live-status.test.ts`
  and confirm the missing projector fails.
- [ ] Implement the pure projector with helpers equivalent to:

  ```ts
  export function projectAgentLiveStatus(input: AgentLiveStatusProjectionInput): AgentLiveStatus;
  function bounded(value: string | null | undefined): string;
  ```

- [ ] Re-run both focused tests and confirm they pass.

### Task 2: Restart-equivalent durable projection

**Files:**
- Modify: `src/runtime/agent-session/managed-context-projection.test.ts`
- Modify: `src/runtime/agent-session/agent-live-status.test.ts`

**Interfaces:**
- Consumes: `projectManagedTaskContext(repository, goalId)` before and after DB reopen.
- Produces: proof that `interrupted` integration and `awaiting_review` resolved
  candidate inputs yield stable live status.

- [ ] Add a failing reopen test that projects managed task context, closes and
  reopens SQLite, and compares `projectAgentLiveStatus` output.
- [ ] Run the two focused test files and confirm the new assertion fails until
  all required durable fields are consumed.
- [ ] Make the smallest projector/input adjustment needed without adding schema.
- [ ] Re-run focused tests and confirm parity.

### Task 3: Existing backend snapshot integration

**Files:**
- Modify: `src/backend/routes/goals.ts`
- Modify: `src/backend/api.test.ts`

**Interfaces:**
- Consumes: route-local sanitized sessions, approvals, delegations,
  `projectManagedTaskContext`, and durable events.
- Produces: `liveStatus` on `GET /api/goals/:id/agent-session`.

- [ ] Add backend tests asserting Worker/integration/terminal/historical
  `liveStatus` and absence of sensitive source fields.
- [ ] Run `node --import tsx --test src/backend/api.test.ts` and confirm
  `liveStatus` is absent.
- [ ] Refactor the route to compute snapshot arrays once and call
  `projectAgentLiveStatus` with sanitized inputs.
- [ ] Re-run backend tests and confirm they pass without changing endpoint shape
  beyond the additive field.

### Task 4: Dashboard compact panel

**Files:**
- Modify: `src/dashboard/api.ts`
- Modify: `src/dashboard/GoalDetail.tsx`
- Modify: `src/dashboard/agent-session-controls-rendering.test.tsx`

**Interfaces:**
- Consumes: `AgentSessionSnapshot.liveStatus`.
- Produces: `LiveStatusPanel` plus total label helpers for known/future values.

- [ ] Add rendering tests for Worker, Judge, Integrator, re-Judge, delivery,
  stalled, terminal, missing metadata, and unknown fallback while retaining
  existing detail/timeline markers.
- [ ] Run the rendering test and confirm the panel text is missing.
- [ ] Add the API type and render a compact panel above managed-session detail.
- [ ] Re-run dashboard tests and confirm all cases pass.

### Task 5: Documentation, OpenSpec tasks, and verification

**Files:**
- Modify: `src/runtime/README.md`
- Modify: `src/dashboard/README.md`
- Modify: `openspec/changes/add-agent-live-status-model/tasks.md`

**Interfaces:** None beyond documented authority precedence.

- [ ] Document state/phase semantics and the structured-state precedence.
- [ ] Mark OpenSpec tasks complete only after their focused checks pass.
- [ ] Run `npm test` and require zero failures.
- [ ] Run `npm run typecheck` and require exit 0.
- [ ] Run `npx openspec validate --all --strict` and require zero failures.
- [ ] Run `git diff --check` and require exit 0.
- [ ] Commit the implementation as one scoped live-status implementation commit.

## Self-Review

- Every delta-spec requirement maps to Tasks 1-4.
- No placeholder steps or schema changes are present.
- The producer/consumer names are consistent across tasks.
- Sensitive fields are excluded at projector and backend test boundaries.
