## Dependency

- [ ] 0.1 Complete `add-agent-observability-event-layer` first; this change depends on durable observation metadata for agent id, parent agent id, task id, role, provider, and model.
- [ ] 0.2 Complete `add-agent-live-status-model` before implementation when possible; this change should reuse live status derivation instead of deriving current agent/task state ad hoc in the dashboard.
- [ ] 0.3 Confirm the scheduler/orchestration scope for this change before implementation; this task file defines the run tree visibility layer, not a full distributed worker system.
- [ ] 0.4 If `add-agent-runtime-control-plane` has landed, use managed session parent metadata and child-session request records as the preferred parent/child and delegated-task source.

## 1. Multi-Agent Tree Contract

- [ ] 1.1 Add domain tests for a multi-agent run tree view model derived from durable agent observations and live status.
- [ ] 1.2 Define tree node types for main agent, subagent, delegated task, command activity, and terminal result when applicable.
- [ ] 1.3 Define required correlation fields: agent id, parent agent id, task id, run id, provider, model, role, and status.
- [ ] 1.4 Define behavior for orphaned, missing, duplicated, or out-of-order parent/child metadata.
- [ ] 1.5 Keep node summaries sanitized and bounded; do not expose raw provider payloads or raw command output.
- [ ] 1.6 Define how child-session request status maps into tree nodes, including pending, accepted, rejected, unsupported, completed, and failed request states.

## 2. Orchestration Event Semantics

- [ ] 2.1 Add tests for spawn, assignment, start, progress, waiting, join, completion, failure, cancellation, and result acceptance/rejection observations.
- [ ] 2.2 Extend or document observation event kinds needed by main-agent/subagent orchestration, such as `agent.spawned`, `agent.assigned`, `agent.waiting`, `agent.joined`, and `agent.cancelled`.
- [ ] 2.3 Ensure parent/child and task correlation metadata round-trips through persistence and API responses.
- [ ] 2.4 Ensure current single-agent provider observations still render as a one-node tree.
- [ ] 2.5 Add fixture coverage where a main session records a child-session request before a real scheduler accepts or rejects it.

## 3. Tree Derivation

- [ ] 3.1 Implement a deterministic tree builder that consumes durable events in timeline order.
- [ ] 3.2 Merge live status model output into each agent or task node.
- [ ] 3.3 Resolve parent-child relationships without assuming events arrive in perfect order.
- [ ] 3.4 Represent incomplete or inconsistent metadata with safe fallback nodes rather than dropping events.
- [ ] 3.5 Add tests for parallel subagents and nested subagent relationships.

## 4. Backend API Integration

- [ ] 4.1 Add backend tests for returning a goal-scoped multi-agent run tree.
- [ ] 4.2 Add a tree endpoint or extend goal detail data without breaking existing goal and event APIs.
- [ ] 4.3 Ensure the tree can be reconstructed from the durable event snapshot after refresh or backend restart.
- [ ] 4.4 Ensure live SSE events can update the tree incrementally without requiring direct provider stdout access.

## 5. Dashboard Tree Rendering

- [ ] 5.1 Add dashboard rendering tests for single-agent, main-agent/subagent, parallel subagent, failed subagent, and orphaned metadata cases.
- [ ] 5.2 Render a compact tree or grouped view showing each agent/task node, role, provider/model, current status, and last activity.
- [ ] 5.3 Allow users to inspect a node's related timeline events without losing the full goal timeline.
- [ ] 5.4 Highlight waiting, stalled, failed, and running nodes so users can tell where work is blocked.
- [ ] 5.5 Keep the first UI pass readable for small local runs; do not require a full workflow designer or graph editor.

## 6. Scheduler Boundary

- [ ] 6.1 Document which orchestration events the future main-agent scheduler must emit.
- [ ] 6.2 Keep distributed worker pools, multi-user fan-out, and remote execution out of this change unless a separate proposal expands the scope.
- [ ] 6.3 Add tests using fixture events before relying on a real scheduler implementation.

## 7. Verification

- [ ] 7.1 Run focused tree derivation, backend API, and dashboard tree rendering tests.
- [ ] 7.2 Run typecheck and the full test suite, documenting any unrelated pre-existing failures.
- [ ] 7.3 Run browser verification showing a fixture-backed multi-agent run tree with live status updates.
- [ ] 7.4 Run `openspec validate add-multi-agent-run-tree --strict`.
