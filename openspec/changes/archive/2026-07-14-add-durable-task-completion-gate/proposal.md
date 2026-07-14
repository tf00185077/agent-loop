## Why

The managed supervisor loop persists sessions, delegations, results, and events, but its authoritative task registry, attempt counters, rejection counters, and per-criterion outcomes still live in memory. A supervisor completion block or a successful child terminal state can therefore outrun durable evidence, and backend restart cannot reconstruct the exact task acceptance state needed to continue safely.

## What Changes

- Persist managed tasks as first-class SQLite state, including frozen acceptance criteria, lineage, current status, attempt count, rejection count, and last safe summary.
- Persist each worker attempt and each criterion's `UNKNOWN`, `PASS`, `FAIL`, or `BLOCKED` outcome without requiring the runtime to reinterpret prior AI prose.
- Formalize the existing review role as an independent judge that returns structured criterion decisions against the frozen task contract.
- Treat executor output and AI self-reported evidence as claims; backend-attested files, backend-run validation, and judge decisions determine acceptance.
- Replace supervisor-declared completion with a runtime completion request gate: all required tasks and criteria must be accepted, and all attested file changes must be delivered successfully before the goal can complete.
- Move final apply/test/commit authority into deterministic backend delivery code after an accepted judge decision; the judge may review and recommend delivery but does not unilaterally mark the goal complete.
- Build continuation context from durable task, attempt, criterion, and review state plus bounded safe summaries instead of replaying complete raw AI responses.
- Keep append-only events as the audit/timeline surface and update state rows plus their corresponding events atomically.
- Defer contract bundle hashing, invariant packs, watchdog recovery, parallel children, nested delegation, distributed execution, and Skill integration.

## Capabilities

### New Capabilities

- `durable-managed-task-state`: Defines the SQLite-backed managed task, attempt, criterion outcome, review decision, restart reconstruction, and context-projection model.

### Modified Capabilities

- `task-acceptance-contracts`: Requires authoritative per-criterion outcomes and prevents a successful child exit or empty evidence result from marking a contracted task accepted.
- `supervisor-goal-orchestration`: Changes the supervisor completion block from an unconditional terminal signal into a request evaluated by the runtime completion gate.
- `review-merge-worktree-gate`: Separates semantic judge decisions from deterministic backend apply, validation, commit, and rollback authority.
- `goal-state-persistence`: Extends SQLite's durable source of truth to managed tasks, attempts, criterion outcomes, and review/delivery decisions.

## Impact

- Adds SQLite schema and repositories for managed task state while preserving existing goals, runs, sessions, delegation requests, and events.
- Replaces the in-memory task registry as the authoritative gate source and updates supervisor continuation context to query durable state.
- Adds structured judge-decision validation and a backend-owned delivery path for accepted worker changes.
- Tightens managed goal completion semantics; previously accepted completion blocks may now be rejected until task, evidence, review, and delivery gaps are closed.
- Requires focused migrations and tests across `src/domain`, `src/persistence`, `src/runtime/agent-session`, backend snapshots, and managed-loop integration tests.

