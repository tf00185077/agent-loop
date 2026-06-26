## Why

auto-agent currently treats Codex Local and Claude Local as one-shot model providers: start a process, wait for one final answer, and observe best-effort progress. That is not enough for the intended product shape, where auto-agent is the control shell around an interactive coding-agent runtime that can request approvals, recover from command failures, continue a session, and eventually spawn other agents.

The recently completed observability layer makes provider activity visible, but it intentionally does not make the backend able to control the agent while it is running. This change adds that missing control-plane boundary before live status and multi-agent tree work build on the wrong abstraction.

## What Changes

- Introduce an agent runtime control plane for managed local agent sessions.
- Split interactive coding-agent runtimes from one-shot model providers while preserving the existing provider-backed smoke path for simple completions.
- Add provider-agnostic session lifecycle semantics for starting, running, waiting for approval, waiting for input, stalled, cancelled, failed, and completed states.
- Add an approval bridge so local CLI agents can surface command approval requests through the backend/dashboard instead of failing or hanging invisibly.
- Add backend session actions for approve, reject, cancel, and future resume/continue behavior.
- Define a runtime adapter interface that can support Codex first and later Claude Code without changing dashboard semantics.
- Define how a main session can request child sessions with parent/child metadata for future multi-agent orchestration.
- Update the expected dependency order so live-status and multi-agent tree features consume runtime-control events and session metadata rather than inferring control state from raw provider observations.

## Capabilities

### New Capabilities

- `agent-runtime-control-plane`: Defines managed interactive agent sessions, lifecycle states, approval handling, cancellation, runtime adapter behavior, and future child-session spawn semantics.

### Modified Capabilities

- `model-provider-integration`: Clarifies that one-shot provider calls are not the control boundary for interactive coding agents, and that Codex Local/Claude Local session execution should move behind runtime adapters.
- `dashboard-goal-lifecycle`: Adds dashboard-facing behavior for agent session state and approval actions while preserving goal-centric navigation and durable timeline semantics.

## Impact

- Backend runtime contracts will gain an agent-session layer beside the existing model-provider contract.
- Codex Local execution will need a managed adapter that can stream runtime events, detect approval requests, and accept control actions while the session is active.
- Persistence will need durable session, command, approval, and parent/child metadata or equivalent event-backed records.
- The dashboard will need controls for pending approval requests, cancellation, and clear waiting/stalled states.
- Existing observability events remain the durable stream, but later live-status and run-tree work should depend on the new session/control-plane semantics.
- This change remains local single-user focused. It does not introduce distributed workers, multi-user permissions, remote execution, or a full scheduler implementation.
