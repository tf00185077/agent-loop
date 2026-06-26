## Why

Once a main agent can spawn other agents, a flat event timeline will not be enough for users to understand who is doing what. Users need a goal-scoped run tree that shows parent/child agent relationships, delegated tasks, and each node's current status.

## What Changes

- Add a multi-agent run tree view model derived from durable observation events and the live status model.
- Represent main agents, subagents, delegated tasks, command activity, terminal results, and parent/child relationships.
- Define orchestration event semantics needed for visibility, including spawn, assignment, waiting, join, completion, failure, cancellation, and result acceptance/rejection.
- Expose a backend API shape that can reconstruct the tree from durable events after refresh or backend restart.
- Render a dashboard tree or grouped view that shows each agent/task node with role, provider/model, current status, last activity, and safe summary.
- Keep scheduler implementation, distributed workers, and remote execution outside this change unless a later proposal expands the scope.

## Capabilities

### New Capabilities
- `multi-agent-run-tree`: Defines how main-agent/subagent relationships and delegated task state are represented, derived, exposed, and rendered.

### Modified Capabilities
- `dashboard-goal-lifecycle`: The dashboard SHALL display a goal-scoped multi-agent tree or grouped view when agent/task relationship metadata is present.

## Impact

- Affects domain/view-model code for tree derivation, backend goal tree APIs or response shapes, dashboard goal detail rendering, and tests.
- Depends on `add-agent-observability-event-layer` for durable agent/task metadata and SHOULD follow `add-agent-live-status-model` so each tree node can reuse derived current status.
- Adds no distributed worker system, multi-user fan-out, remote execution, or full scheduler unless a separate proposal changes scope.
