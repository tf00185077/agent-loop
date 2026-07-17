# Executable Acceptance Checks

## Why

Acceptance today is claim-shaped: workers assert evidence, the judge reads the claims, and nothing in the backend ever executes a check. The whole pipeline defends process integrity (frozen contracts, independent judge, write-ahead delivery) but result authenticity still rests on LLM self-report — a worker that writes "tests pass" without running them, or a vacuous test that cannot fail, sails through. This change makes the backend execute acceptance checks itself and adds two deterministic anti-gaming gates (red-green discrimination, protected test paths), converting criterion outcomes from believed prose into observed exit codes.

## What Changes

- Acceptance criteria MAY carry an executable `check` (kind, command, protected paths), frozen with the contract like criterion text; the backend runs checked criteria in the worker's worktree at review time and records the executed outcome durably. The judge decides unchecked criteria as today but cannot override an executed FAIL.
- **Red-green discrimination** for `red_green` checks: the same command also runs against the pre-change baseline; a check that already passes on the baseline does not discriminate the change and the attempt is rejected with a teaching reason. `regression` checks instead require baseline-green and candidate-green.
- **Protected test paths**: a worker attempt whose attested diff touches a check's protected paths is rejected deterministically — whoever must pass a check cannot edit it.
- Check execution results (command, exit code, truncated sanitized output) are persisted per criterion per attempt and surface in the judge packet and the dashboard timeline.

## Capabilities

### New Capabilities
- `executable-acceptance-checks`: backend-executed acceptance checks — check contract shape and freezing, execution at review time, red-green/regression discrimination against the baseline, protected-path enforcement, durable execution evidence, and visible degradation when a check cannot run.

### Modified Capabilities
- `task-acceptance-contracts`: "Frozen per-task acceptance criteria" gains the optional check definition as frozen contract state; "Contracted task acceptance requires authoritative criterion decisions" gains the rule that executed outcomes are authoritative for checked criteria (judge prose cannot flip an executed FAIL to PASS).

## Impact

- `src/domain` — `TaskAcceptanceCriterion` gains optional `check`; control-event validation for task lists.
- `src/persistence/managed-task-repository.ts` — persist check definitions with criteria; per-attempt check execution records.
- `src/runtime/agent-session/` — check-runner service (worktree + baseline execution), wiring into the judge/review path in `agent-session-manager.ts` / `delegation-coordinator.ts`, protected-path gate against attested files, judge packet enrichment.
- `supervisor-prompt.ts` — contract text and examples for authoring checks (informational).
- Dashboard timeline gains check-execution events; no API surface changes.

## Non-Goals

- No adversarial test authorship (independent test-author role) — architecture supports it later; out of scope here.
- No mutation testing beyond the red-green baseline probe.
- No sandboxing change: check commands run with the same trust as the worker CLI already does in the same worktree.
- No human sign-off flow (`waiting_user`) — separate change.
- Checks remain optional per criterion: prose-only criteria keep today's judge-decided flow.
