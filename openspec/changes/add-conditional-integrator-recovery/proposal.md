## Why

Backend-owned delivery currently restores a clean checkpoint and returns a conflict to the Supervisor when an accepted worker candidate cannot be cherry-picked. This is safe, but it adds a full supervisor round-trip before an LLM can resolve a conflict that is already known and bounded. A conditional Integrator child can resolve that conflict immediately in isolation while preserving backend and Judge authority.

## What Changes

- Add an `integrator` LLM role that the backend dispatches only after a real candidate-apply conflict; conflict-free delivery remains deterministic and invokes no extra LLM.
- Reproduce the conflict in a runtime-owned integration worktree rooted at the recorded supervisor checkpoint and give the Integrator only the frozen task contract, candidate identity, bounded conflict context, and isolated worktree.
- Require a structured `managed_integration.result`, verify that the Integrator did not move `HEAD`, leave unresolved index entries, or change files outside the allowed candidate/conflict scope, and let the backend create the resolved candidate commit.
- Invalidate the earlier Judge acceptance when integration changes the candidate and require a fresh Judge decision bound to the resolved candidate before backend apply, fixed validation, and final commit.
- Persist integration attempts, candidate identities, conflict files, outcomes, and the relationship to re-review and delivery so recovery survives process restart.
- Bound automatic recovery to one Integrator attempt per conflicted delivery; failed or repeated conflict returns durable control to the Supervisor instead of looping.
- Expose `integrator` in role-agent settings so users can choose its provider/model independently, with the existing backend-controlled fallback policy.
- Non-goals: general automatic repair after test failure, unrestricted merge agents, parallel child execution, distributed workers, and giving any LLM direct authority over the supervisor workspace or final commit.

## Capabilities

### New Capabilities

- `conditional-integration-recovery`: Backend-triggered, isolated, bounded LLM conflict resolution with candidate attestation and deterministic handoff.

### Modified Capabilities

- `review-merge-worktree-gate`: A delivery conflict can enter conditional integration recovery, and any resolved candidate requires fresh Judge approval before final delivery.
- `durable-managed-task-state`: Integration attempts and candidate-bound review state become durable runtime authority and survive restart.
- `role-agent-assignments`: `integrator` becomes a configurable child role resolved by backend policy.

## Impact

- Domain/control-plane contracts gain the Integrator role, structured result, integration lifecycle, and candidate-bound review fields.
- SQLite gains durable integration-attempt state and additive review/delivery candidate references.
- Agent-session orchestration gains backend-triggered conditional dispatch and re-review without a Supervisor continuation.
- Worktree and delivery services gain isolated conflict reproduction, scope/index/HEAD verification, resolved candidate creation, cleanup, and restart-safe recovery.
- Provider settings API/dashboard, managed context projection, README, and architecture documentation expose the new role and lifecycle.
- No new external dependency or remote service is required.
