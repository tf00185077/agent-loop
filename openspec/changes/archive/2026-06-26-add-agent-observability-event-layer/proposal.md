## Why

Users need to know whether an agent run is still making progress before the final provider response is available. This becomes more important as auto-agent moves toward a main-agent/subagent workflow where the main agent plans work, delegates tasks, and users need to understand what each active agent is doing instead of waiting on a silent terminal process.

## What Changes

- Introduce a provider-agnostic agent observability event layer for durable, live timeline updates.
- Convert provider process activity into structured progress events such as agent heartbeat, command started/completed/failed, subtask started/completed/failed, and provider output summaries.
- Extend the Codex Local provider path to consume a more informative execution stream, preferring `codex exec --json` when available, while preserving final-response behavior.
- Persist observability events before publishing them to the live dashboard stream so refresh/reconnect uses the same source of truth.
- Add metadata fields that can represent main agents, subagents, parent/child relationships, task ids, provider/model, and raw provider event provenance.
- Keep raw stdout/stderr out of the dashboard by default; sanitize process output and expose only safe summaries or bounded tails.
- Do not implement full multi-agent scheduling in this change; design the event layer so a later orchestration change can reuse it.

## Capabilities

### New Capabilities
- `agent-observability-events`: Defines provider-agnostic durable events for tracking agent liveness, command execution, subtask progress, and parent/child agent activity.

### Modified Capabilities
- `model-provider-integration`: Provider adapters SHALL emit structured observability progress while preserving final result/error semantics and credential safety.
- `dashboard-goal-lifecycle`: The dashboard timeline SHALL display live observability events for active runs so users can distinguish running, stalled, completed, and failed work.

## Impact

- Affects provider contracts, Codex Local provider execution, provider runtime event persistence, event data shape, dashboard timeline rendering, and tests.
- May replace or augment the current Codex `--output-last-message` only path with JSONL event parsing while still producing a final provider response.
- Adds no new credential storage, no dashboard-side provider execution, no distributed workers, and no full main-agent/subagent scheduler in this change.
