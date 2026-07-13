# Design: add-role-agent-assignments

## Context

`delegation-coordinator.acceptAndStartWorker` receives `input.adapter` — the parent session's adapter — and uses it for child capability detection and spawn; child runs are created with the parent's `providerId`/`modelLabel`. There is no assignment point per role. Provider settings persist a single selected provider (the supervisor's), with only the selected provider's command path retained on save. The user asked for configuration: which agent runs which behavior.

## Goals / Non-Goals

**Goals:**

- User-configurable role→agent mapping for `worker`, `spec_writer`, `review_merge`; absent mapping = inherit goal provider (bit-for-bit today's behavior).
- Resolution is backend-only at dispatch; the supervising LLM cannot select providers.
- Assigned-provider failure degrades visibly to the goal default.
- Timeline evidence records the resolved provider/model per child.

**Non-Goals:**

- Per-run overrides at goal start, per-task assignments, voter assignments, changing how the supervisor's own provider is selected.

## Decisions

### 1. Assignment shape carries its own command path

`roleAssignments: Partial<Record<"worker" | "spec_writer" | "review_merge", {provider: "codex-local" | "claude-local" | "mock", modelLabel: string, commandPath: string | null}>>`. The settings row only retains the *selected* provider's command path, so an assignment referencing the other provider must carry its own; when null/stale, resolution self-heals through the existing detection machinery (`resolveCodexCommandPath` / `resolveCliCommandPath`). `spec_writer` is included now so `add-goal-scale-decomposition` lands onto an existing role name. `mock` is allowed chiefly for deterministic tests.

### 2. A role-adapter resolver injected into the session manager

`createRoleAdapterResolver(deps)` returns `resolve(role) → {adapter, providerId, modelLabel} | null`. Resolution order per role:

1. No assignment → `null` (caller keeps the parent adapter — today's path).
2. Injected `agentRuntimeAdapters[provider]` (test seam, mirrors goal-start precedence).
3. Constructed adapter (`createCodexRuntimeAdapter`/`createClaudeRuntimeAdapter`) from the assignment's resolved command path and model label, with the existing probe/session-runner seams.

The session manager calls the resolver in `persistDelegationControlEvent` before dispatch and passes the resolved trio into the coordinator; `StartWorkerDelegationInput` already carries `providerId`/`modelLabel`/`adapter`, so the coordinator change is only that these now describe the child, not the parent. **Alternative rejected:** resolving inside the coordinator — the manager is where control-plane policy already lives (registry gates, narrowing), and the coordinator stays a mechanism.

### 3. Capability-gated fallback with a durable event

Before dispatch, the resolver's adapter runs `detectCapabilities()`; if `eventStreaming` is false, the manager records `role_assignment.downgraded` (role, assigned provider, safe reason) and dispatches with the parent adapter instead. Detection results are cached per goal to avoid re-probing every delegation.

### 4. Continuations stay on the supervisor's adapter

Fresh continuations and nudges are supervisor turns and always use the goal's adapter; assignments apply only to child spawns keyed by delegation role. `spec:<changeId>` tasks (future) dispatch with role `spec_writer` — until that change lands, the role is dormant configuration.

### 5. Settings and API stay credential-free

Assignment command paths pass through `sanitizeProviderCommandPath` on save and read; role assignments ride a JSON `role_assignments` column (additive `ensureColumn`). The PUT/GET provider-settings routes round-trip `roleAssignments` with validation (known roles, known providers, string model labels); invalid shapes are rejected with 400.

## Risks / Trade-offs

- [Assigned CLI missing at dispatch time] → Self-healing detection first, then capability fallback with the durable downgrade event; a goal never fails because of an assignment.
- [Mixed providers produce inconsistent control-block dialects] → Both adapters already share the provider-neutral extraction and contract prompts; the live risk is model quality, which is exactly the knob the user asked for.
- [Per-delegation capability probing cost] → Cached per goal after first resolution.
- [Settings switch nulls the other provider's stored path] → Assignments carry their own path (Decision 1), so switching the main provider does not corrupt role assignments.

## Migration Plan

1. Domain types + sanitization + settings persistence round-trip.
2. Provider-settings API round-trip + validation.
3. Role-adapter resolver + session-manager dispatch wiring + downgrade fallback + resolved-provider evidence.
4. Dashboard per-role controls.
5. Full verification + README; live mixed-provider smoke (Codex supervisor + Claude worker) if both CLIs are available.

Rollback: all additive; empty `roleAssignments` reproduces current behavior exactly.

## Open Questions

- Should the dashboard offer a connection test per assignment (v1: no — capability fallback covers it at run time)?
