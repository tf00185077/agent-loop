## Context

The current managed loop already persists goals, runs, sessions, delegation requests, acceptance JSON, result summaries, commands, approvals, and timeline events. The decision-making task model is different: `GoalTaskRegistry` and `GoalChangeRegistry` keep current status, counters, lineage, and criterion outcomes in process memory. A successful child terminal event can mark a task done even when some criteria remain unknown, and a flat managed goal completes when the supervisor emits a valid completion block.

This change closes that minimum correctness gap without introducing the full Contract Runtime described in the longer-term architecture. SQLite remains the local source of truth, existing delegation rows remain worker-attempt records, and existing events remain the audit/timeline surface.

## Goals / Non-Goals

**Goals:**

- Make managed task, attempt, criterion, review, and delivery state reconstructable directly from SQLite after backend restart.
- Ensure AI prose and child process success are stored as claims, not interpreted as authoritative task acceptance.
- Require one structured independent judge decision that covers every frozen criterion before a contracted task is accepted.
- Let the supervisor request completion while the backend alone decides whether the durable completion conditions are satisfied.
- Move apply, fixed validation, commit, and rollback into deterministic backend delivery code.
- Compose continuation context from durable structured state and bounded safe summaries.

**Non-Goals:**

- Canonical contract bundles, hashes, amendments, shared constitutions, role overlays, or invariant packs.
- Watchdog repair, resumable process reattachment, distributed workers, parallel children, or nested delegation.
- Complex permission policy, per-file contract allowlists, remote artifact storage, or multi-user access.
- Replacing SQLite with a queue or event-store product.
- Storing or replaying unsanitized raw provider output by default.
- Creating a Hermes/OpenClaw Skill in this change.

## Decisions

### 1. Use durable current-state tables plus append-only events

SQLite current-state rows are the runtime's authoritative gate input. Every meaningful transition also appends a sanitized event in the same database transaction. Startup reads current-state rows; it does not ask an agent to reinterpret prior prose.

Alternative considered: make events the only source of truth and rebuild all state by replay. Rejected for this increment because existing event payloads were designed for observability, not as a versioned event-sourcing contract. The schema added here can support a later replay reducer without making it a prerequisite.

### 2. Add a managed task aggregate and reuse delegation rows as attempts

The minimum durable model is:

- `managed_tasks`: identity, goal/change/parent lineage, current status, attempt and substantive-rejection counters, last cited criteria, last safe summary, and timestamps.
- `managed_task_criteria`: immutable criterion id/text definitions per task and the current authoritative outcome.
- Existing `agent_delegation_requests` with an added attempt number: each worker delegation remains the execution-attempt record and already carries child session, acceptance, structured result, and lifecycle timestamps.
- `managed_task_criterion_results`: attempt-scoped executor evidence plus judge outcome, reason, and safe evidence metadata.
- `managed_task_reviews`: one structured judge verdict per reviewed worker attempt, including decision and cited criteria.
- `managed_task_deliveries`: backend apply/test/commit or rollback outcome for an accepted review.

Variable provider payloads remain JSON-serialized TEXT; identifiers, statuses, counters, outcomes, hashes/SHAs, and timestamps used by runtime gates are first-class typed columns.

Alternative considered: add only a transcript/messages table. Rejected because transcripts cannot answer retry, criterion, delivery, or completion queries without another model interpretation.

### 3. Persist frozen criteria at task registration

Accepting a supervisor task list creates or updates `managed_tasks` and inserts criterion definitions transactionally. A later task-list or delegation may not mutate an existing criterion id/text pair. Parent/split lineage and rejection counters are read and updated from the repository rather than an in-memory registry.

Historical terminal goals are left unchanged. For a non-terminal historical goal, safe backfill may reconstruct task identity and criteria from durable task-list events and delegation rows; any criterion that cannot be proven is `UNKNOWN` and blocks completion until reviewed. The migration never infers `PASS` from a plain success summary.

### 4. Formalize the existing review child as the independent judge

To avoid a provider-settings and API migration in this increment, the transport role id remains `review_merge`, but its semantic authority is narrowed to Judge: inspect the worker result, diff, frozen criteria, and attested evidence; then emit a validated `managed_review.decision` control block. The decision must cover every required criterion with `PASS`, `FAIL`, or `BLOCKED` and include a bounded safe reason/evidence reference.

The supervisor/owner may request review and react to its outcome, but cannot manufacture criterion decisions. Unknown or malformed judge output leaves the attempt awaiting review and cannot advance task status.

Alternative considered: add a new `judge` role id immediately. Deferred because it would require a role-assignment migration while adding no enforcement beyond the narrowed existing role. A later rename can be purely representational after the protocol is stable.

### 5. Backend owns delivery and commit

After an accepted judge decision, a backend delivery service:

1. verifies the worker worktree and attested paths still match the reviewed attempt;
2. creates a runtime-owned candidate commit in the worker worktree;
3. requires a clean supervisor workspace and records its HEAD checkpoint;
4. applies the candidate commit to the supervisor workspace;
5. runs the configured fixed validation command;
6. records the resulting commit SHA on success, or restores and verifies the checkpoint on failure.

The judge never marks delivery successful. A task with attested file changes becomes `accepted` only after delivery succeeds. A task with no workspace changes may become accepted immediately after all criterion decisions pass.

Alternative considered: allow the review agent to apply and commit in its session. Rejected because semantic review and irreversible delivery would share authority and provider output could bypass deterministic validation.

### 6. Completion is a backend-evaluated request

`managed_delegation.complete` remains the supervisor transport, but changes meaning from unconditional completion to `completion_requested`. The runtime accepts it only when:

- every registered leaf task is accepted, or a split task is satisfied by all accepted descendants;
- every required criterion has authoritative `PASS`;
- no worker attempt, judge review, or delivery is active/pending;
- no successful worker attempt has undelivered attested file changes;
- any change plan satisfies its existing archive gate.

On failure the backend records the exact structured gaps and continues the supervisor with those gaps. On success it atomically completes the run/goal and records the terminal events. An uncontracted delegation may run for compatibility but cannot satisfy goal completion; the supervisor must register a contracted task representing that work.

### 7. Context is compiled from structured state

Supervisor continuation prompts include goal/change context, task statuses, counters, criterion outcomes, last judge decision, delivery status, and bounded safe summaries. Full historical AI responses are not replayed as authoritative memory. Raw provider payload retention remains outside this change; existing sanitization rules continue to apply.

## Risks / Trade-offs

- [More tables and transitions increase persistence complexity] -> Keep repositories aggregate-oriented and update state plus event inside one SQLite transaction.
- [Existing non-terminal goals lack authoritative criterion decisions] -> Backfill only provable definitions and counters; mark uncertain outcomes `UNKNOWN` and fail closed at completion.
- [Keeping the `review_merge` role id can obscure its narrowed Judge semantics] -> Document the compatibility choice in prompts, types, and events; expose `judgeDecision` as the durable semantic object.
- [Backend-created candidate commits can fail because of git identity or conflicts] -> Record typed delivery failures, leave the task unaccepted, and verify rollback to the checkpoint.
- [A single judge can make a wrong semantic decision] -> Preserve evidence and decision records for audit; quorum judging remains a future enhancement.
- [State rows and events can diverge] -> Require one transaction boundary and tests that reopen the database and compare the durable aggregate with emitted events.

## Migration Plan

1. Add the new tables/columns and repositories with additive migrations.
2. Move task registration, attempt counting, rejection counting, criterion updates, and continuation history reads from in-memory registries to repositories.
3. Add structured judge-decision parsing and persistence while keeping existing review role configuration compatible.
4. Add the backend delivery service and typed apply/test/commit/rollback outcomes.
5. Replace direct completion handling with the durable completion evaluator.
6. Add safe backfill/restart tests, integration tests, and a live managed-provider smoke test.

Rollback keeps the additive tables intact, disables the new completion/delivery gate, and returns dispatch to the previous registry path. No migration deletes historical events or delegation rows.

## Open Questions

- None required before implementation. The existing configured review-merge fixed test command remains the default validation command for this increment.


