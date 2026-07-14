## Context

The managed runtime separates semantic authority from mutation authority: Worker children modify isolated worktrees, the independent Judge decides frozen criteria, and deterministic backend delivery creates/applies commits, runs fixed validation, and restores checkpoints on failure. Today a cherry-pick conflict is recorded only after the supervisor workspace is restored, so the Supervisor must spend another continuation deciding to delegate conflict repair.

The conflict is already a narrow, observable condition. The runtime can recover faster by dispatching a specialized Integrator immediately, but it must not let that LLM mutate the supervisor workspace, inherit the Judge's authority, or reuse a Judge decision made against different content. The existing single-active-child and depth-one constraints remain: Integrator and re-Judge run sequentially after the original Judge has terminated.

## Goals / Non-Goals

**Goals:**

- Invoke an Integrator only after backend Git observes a real apply conflict.
- Resolve conflicts in a disposable integration worktree rooted at the recorded clean checkpoint.
- Keep final staging, candidate creation, validation, commit, rollback, and durable state transitions under backend authority.
- Bind the post-integration Judge decision to the exact resolved candidate.
- Persist enough integration state to fail closed and explain or continue safely after restart.
- Limit each conflicted delivery to one automatic Integrator attempt.

**Non-Goals:**

- Invoking an Integrator for conflict-free delivery or ordinary test failures.
- Letting an LLM commit into or directly modify the supervisor workspace.
- Automatically retrying Integrator failure, repeated conflict, rejected re-review, or failed fixed validation.
- Parallel children, nested delegation, distributed worktrees, or generalized autonomous merge queues.

## Decisions

### 1. Conditional backend dispatch rather than a Supervisor request

`integrator` is a backend-triggered child role. The delivery service returns typed conflict evidence, and the session manager starts the recovery pipeline immediately without waiting for a new Supervisor control block. This removes the avoidable continuation while retaining the existing provider-assignment resolver and durable child lifecycle.

Alternative considered: require the Supervisor to request every Integrator. That preserves one dispatch mechanism but is the latency this change is intended to remove. Invoking the role on every delivery was also rejected because conflict-free Git operations are deterministic and need no LLM cost.

### 2. Reproduce conflict in a disposable integration worktree

After restoring and verifying the supervisor checkpoint, the backend creates a runtime-owned integration worktree at that checkpoint and runs the original candidate apply there with no final commit. The Integrator receives that worktree as its cwd, frozen criteria, original candidate SHA, checkpoint SHA, conflict file list, and bounded Git diagnostics.

The Integrator emits one `managed_integration.result` and is instructed to resolve files without committing. After it exits, the backend requires: `HEAD` still equals the checkpoint, the unmerged index is empty, the changed-file set is contained in the original candidate file set plus the observed conflict set, and the resulting tree has changes. The backend then stages the allowed files and creates the resolved candidate commit.

Alternative considered: let the Integrator edit the restored supervisor workspace. This has a larger blast radius and makes rollback and concurrent user edits unsafe. Asking the original Worker to rebase was rejected because it requires a Supervisor round-trip and repeats a broader implementation role.

### 3. Fresh candidate-bound Judge decision is mandatory

The original Judge decision remains historical evidence for the Worker candidate but cannot authorize resolved content. The backend dispatches a fresh `review_merge` child with the resolved candidate SHA, integration attempt id, final diff, frozen criteria, and prior evidence. A valid `managed_review.decision` must target that candidate exactly. Only an accepted re-review advances recovery to final delivery.

Alternative considered: reuse the original acceptance when only conflict files changed. Conflict resolution is itself a semantic edit, so path-based similarity cannot prove equivalent behavior.

### 4. Backend retains final delivery authority

After re-acceptance, the backend applies the resolved candidate to the still-clean supervisor checkpoint, runs the configured fixed validation command, verifies a clean resulting workspace, and records the delivered SHA. Any apply conflict, failed validation, or unverifiable state follows the existing verified rollback path. Integrator prose or claimed tests never override backend observations.

### 5. Durable integration attempt and bounded retry

SQLite stores one integration attempt per conflicted worker delivery with task/worker/integrator ids, lifecycle status, checkpoint SHA, original and resolved candidate SHAs, conflict and allowed files, bounded summaries, and timestamps. Review and delivery records optionally reference the integration attempt and reviewed candidate SHA. State transitions and audit events are atomic.

Only one Integrator attempt is permitted for a given worker delegation and original candidate. Terminal failure, a second apply conflict, invalid structured output, scope violation, unresolved index, moved `HEAD`, Judge rejection/block, or interrupted non-resumable child returns a durable failure/blocking observation to the Supervisor. Restart projection never infers acceptance from Integrator prose and never starts a duplicate attempt.

### 6. Role configuration follows existing backend policy

`integrator` is added to assignable roles. The backend resolves its provider/model at dispatch, records the resolved agent, and visibly falls back to the goal provider when the assignment is unavailable. Supervisor or Integrator output cannot select a provider.

## Risks / Trade-offs

- [Resolved content differs materially from the accepted Worker diff] → Invalidate prior authority and require a candidate-bound re-review.
- [Integrator runs arbitrary Git commands] → Use a disposable worktree and reject moved `HEAD`, unresolved index, and out-of-scope files before candidate creation.
- [Immediate recovery increases orchestration complexity] → Keep it as a sequential backend state machine with typed durable transitions and one attempt only.
- [Restart occurs while an LLM process is active] → Persist the attempt before launch; on loss of a resumable process, fail closed and return control without duplicate automatic dispatch.
- [Conflict repeats when applying the resolved candidate] → Restore the supervisor checkpoint, record terminal recovery failure, and return to the Supervisor.
- [Extra LLM cost] → Invoke Integrator and second Judge only on observed conflicts.

## Migration Plan

Additive SQLite initialization creates the integration table and nullable candidate/integration references without rewriting existing task history. Existing role settings deserialize with no Integrator assignment and therefore inherit the goal provider. Existing deliveries and reviews retain null integration references and preserve their current meaning. Rollback is code-only: older code ignores the additive table/columns, while incomplete integration attempts remain non-authoritative records.

## Open Questions

None. The MVP intentionally fixes the automatic attempt limit at one and returns all remaining recovery choices to the Supervisor.
