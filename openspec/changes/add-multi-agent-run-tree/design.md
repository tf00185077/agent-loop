## Context

`add-agent-observability-event-layer` provides durable observation metadata for agent ids, parent agent ids, task ids, provider/model, and activity events. `add-agent-live-status-model` derives "what is happening now" from those events. This change builds on both so a future main-agent/subagent workflow can be shown as a structured run tree instead of a flat stream of unrelated messages.

## Goals / Non-Goals

**Goals:**

- Derive a goal-scoped multi-agent tree from durable events.
- Show parent-child agent relationships and delegated task relationships.
- Merge live status into each agent or task node.
- Tolerate missing, orphaned, duplicated, and out-of-order relationship metadata.
- Provide dashboard rendering that helps users identify running, waiting, stalled, failed, and completed work.
- Document the orchestration events a future scheduler must emit.

**Non-Goals:**

- Do not implement a distributed worker pool, remote executor, or multi-user fan-out.
- Do not require a full scheduler implementation before fixture-backed tree derivation can be tested.
- Do not replace the durable timeline; the tree is a grouped view over the same facts.
- Do not expose raw provider output or raw provider event payloads.
- Do not build a workflow designer or graph editor in the first UI pass.

## Decisions

1. Treat the tree as a derived view.

   The durable event log remains the source of truth. The tree builder consumes events in timeline order and creates nodes for agents, tasks, commands, and terminal results when relationship metadata exists.

2. Reuse live status per node.

   Node status should come from the live status model instead of being independently inferred in the dashboard. This keeps "what is happening now" consistent between compact status and tree views.

3. Define scheduler-facing event semantics.

   The future scheduler should emit semantic observations such as spawned, assigned, waiting, joined, cancelled, completed, failed, and result accepted/rejected. The tree should not infer these from free-form messages.

4. Keep fallback behavior explicit.

   Missing or inconsistent metadata should create safe fallback or orphan nodes rather than dropping observations. Single-agent runs should render as a one-node tree.

5. Keep the first UI compact.

   The dashboard should show a readable tree or grouped list with node status and allow drilling into related timeline events. A visual graph editor would be premature.

## Risks / Trade-offs

- [Risk] Tree semantics can overfit before scheduler implementation exists. -> Mitigation: use fixture events and document scheduler requirements without implementing scheduling here.
- [Risk] Out-of-order events can create confusing trees. -> Mitigation: use deterministic reconciliation and fallback nodes.
- [Risk] Tree and timeline can drift. -> Mitigation: derive both from the same durable events and link nodes back to related timeline events.
- [Risk] Multi-agent UI can become too dense. -> Mitigation: keep the first pass compact and status-oriented.

## Migration Plan

1. Complete `add-agent-observability-event-layer`.
2. Complete `add-agent-live-status-model` when possible.
3. Define the tree view model and fixture event sequences.
4. Add backend tree derivation and API exposure.
5. Render the tree or grouped view in the dashboard, linked to the existing timeline.
6. Document scheduler event emission requirements for a later orchestration change.
