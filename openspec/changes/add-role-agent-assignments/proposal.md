# Proposal: add-role-agent-assignments

## Why

Every child agent today inherits the supervisor's provider and model: the delegation coordinator spawns workers and review-merge children through the parent session's adapter. Users cannot express "supervise with Codex, implement with Claude Sonnet, review with the cheap default" — a real cost/quality/quota policy decision that belongs to the user, not to the supervising LLM (which knows nothing about installed CLIs, subscriptions, or budgets) and not to prompt text. Role→agent assignment must be user configuration resolved by the backend at dispatch.

## What Changes

- Provider settings gain optional `roleAssignments`: per child role (`worker`, `spec_writer`, `review_merge`) a provider, model label, and optional command path. Unassigned roles inherit the goal's selected provider — existing behavior is preserved verbatim when no assignments exist. The supervisor's agent remains the goal's main provider selection.
- The backend resolves role→adapter at delegation dispatch through an adapter resolver: injected test adapters first, then adapters constructed from the assignment (command path self-healing via existing CLI detection). Control blocks contain no provider fields; the supervising LLM cannot choose execution backends.
- Capability-gated fallback: when an assigned adapter cannot support managed execution, the backend records a durable `role_assignment.downgraded` event and falls back to the goal's default adapter — visible, never silent.
- Child runs and delegation lifecycle events record the resolved provider/model actually used, so the timeline shows which agent executed each role.
- The dashboard provider setup exposes per-role assignment controls (provider picker + model label + command path reusing existing patterns), persisted credential-free.

## Capabilities

### New Capabilities

- `role-agent-assignments`: The role→agent assignment model — configuration shape, backend-only resolution order, capability-gated fallback, and durable resolved-provider evidence.

### Modified Capabilities

- `model-provider-integration`: Provider settings SHALL persist sanitized role assignments and the dashboard SHALL provide per-role assignment controls; settings APIs SHALL round-trip them credential-free.
- `managed-delegation-core`: Child sessions SHALL be spawned through the role-resolved adapter rather than inheriting the parent session's adapter, and SHALL record the resolved provider and model durably.

## Impact

- **Domain**: `AgentRoleAssignment`/`RoleAssignments` types on provider settings; sanitization for assignment command paths.
- **Persistence**: additive `role_assignments` JSON column on `provider_settings`.
- **Backend**: provider-settings routes accept/return `roleAssignments`; an adapter resolver built from saved settings + existing test seams (injected adapters, probes, session runners); `selectRuntimeForSettings` passes the resolver into the session manager.
- **Runtime**: session manager resolves the child adapter per role before calling the coordinator; coordinator uses the resolved adapter/provider/model for child capability detection, run rows, and spawn.
- **Dashboard**: per-role assignment section in provider setup.
- **Non-goals**: per-run role overrides on goal start (settings-level only in v1), per-task assignments, quorum-voter provider assignment, supervisor role reassignment separate from the main provider picker.
