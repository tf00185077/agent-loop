## Context

`add-agent-observability-event-layer` made Codex Local activity visible by mapping provider events into durable timeline events. That solves "what happened?" but not "who is in charge of the running agent?" The current provider-backed runtime still calls a provider once and waits for a final response. When Codex hits a command failure, a PowerShell execution-policy failure, a sandbox approval prompt, or a long-running operation, auto-agent can observe some output but cannot reliably approve, reject, cancel, continue, or delegate work.

The intended product is an agent control shell: the dashboard and backend own goals, runs, durable state, approvals, and session orchestration, while Codex or Claude Code performs the coding-agent work behind a provider-specific adapter. The architecture therefore needs a control plane between the goal runtime and local agent CLIs.

## Goals / Non-Goals

**Goals:**

- Define a managed agent-session abstraction separate from one-shot model completions.
- Let the backend start, observe, approve, reject, cancel, and eventually resume an interactive local agent session.
- Keep Codex and future Claude Code execution behind provider-specific runtime adapters.
- Persist enough session, command, approval, and parent/child metadata to reconstruct state after refresh or backend restart.
- Route all dashboard visibility through durable events and backend APIs.
- Establish the dependency order for follow-up live-status and multi-agent tree changes.

**Non-Goals:**

- Do not implement distributed workers, remote execution, or multi-user permission policy.
- Do not build a full autonomous scheduler in this change.
- Do not make the dashboard talk directly to Codex, Claude, stdout, stderr, or provider credentials.
- Do not require every CLI provider to support approvals in the first adapter implementation.
- Do not replace the existing one-shot provider path for simple mock or OpenAI-compatible smoke execution.

## Decisions

1. Split `ModelProvider` from `AgentRuntimeAdapter`.

   One-shot providers answer a prompt and return text. Interactive coding agents expose a longer-lived session that emits events and accepts control actions. The new boundary should look conceptually like:

   ```ts
   interface AgentRuntimeAdapter {
     startSession(input: AgentSessionStartInput): Promise<AgentSessionHandle>;
   }

   interface AgentSessionHandle {
     sessionId: string;
     events(): AsyncIterable<AgentRuntimeEvent>;
     send(input: AgentSessionInput): Promise<void>;
     approve(requestId: string): Promise<void>;
     reject(requestId: string, reason?: string): Promise<void>;
     cancel(reason?: string): Promise<void>;
   }
   ```

   Alternative considered: extend the model-provider callback until it can express every runtime action. That would blur two very different contracts and keep the system pretending an interactive coding agent is a completion endpoint.

2. Make the backend session manager the source of control truth.

   The backend should create a durable agent session for a goal run, persist state transitions, persist pending approval requests, and publish corresponding events. Adapter process state may remain in memory while the process is alive, but user-visible state cannot depend on ephemeral process objects.

   Alternative considered: let each provider adapter own all state and only stream observations upward. That is simpler initially, but it leaves approvals, cancellation, and future multi-agent relationships fragmented by provider.

3. Represent approval as an explicit runtime state.

   A local CLI agent can need approval before running a shell command or editing files. The adapter should map provider-specific prompts or JSONL events into an `approvalRequested` runtime event. The backend persists the request, marks the session `waiting_approval`, and exposes approve/reject actions. The adapter resumes only after a backend action resolves the request.

   Alternative considered: auto-approve everything locally for MVP. That would make demos smoother but undermine the dashboard's purpose as the user-facing control shell, and it would not solve the user's observed "where is approve?" gap.

4. Keep observability events as the dashboard stream.

   Runtime control events should be persisted as durable goal events, then sent through the existing SSE path. The dashboard should not subscribe to raw provider streams. New event data can carry `sessionId`, `commandId`, `approvalRequestId`, `agentId`, `parentAgentId`, `taskId`, provider, model, and safe summaries.

   Alternative considered: add a separate live runtime websocket. That could support richer process control later, but it would duplicate state semantics before the durable event model is exhausted.

5. Add child-session semantics before a scheduler.

   The control plane should define how a main session requests a child session, including `parentSessionId`, `parentAgentId`, `agentRole`, `taskId`, and prompt/context metadata. The first implementation can record or reject spawn requests without building a full scheduler. This gives the later run tree a real source of parent/child truth.

   Alternative considered: postpone all child metadata until multi-agent orchestration. That would force live-status and tree work to invent fixture-only relationships and then migrate again.

6. Treat CLI capability detection as part of adapter startup.

   Codex and Claude Code may differ in JSONL support, approval support, model flags, and non-interactive behavior. Each adapter should report capabilities at session start and degrade clearly when a feature is unsupported. For example, if Codex cannot support interactive approval through the chosen command mode, the backend should fail visibly or mark the session unsupported rather than timing out as if the agent chose to stop.

   Alternative considered: assume current CLI behavior and patch failures later. The recent errors around wrong paths, `npm.ps1`, and hidden approval gaps show that silent assumptions create poor user feedback.

## Risks / Trade-offs

- [Risk] Codex CLI may not expose a stable non-interactive approval protocol. -> Mitigation: make Codex approval support a spike and capability check; if unavailable, persist a clear unsupported-control error instead of hanging.
- [Risk] The control plane could become a scheduler too early. -> Mitigation: define child-session requests and metadata, but keep actual scheduling implementation out of this change.
- [Risk] Persisting session and approval state duplicates some durable event information. -> Mitigation: treat events as history and session records as current/control state, with reducer tests proving they agree.
- [Risk] Local process recovery after backend restart may be limited. -> Mitigation: reconstruct visible state durably, mark orphaned in-memory sessions as failed/stalled, and reserve true process reattachment for a later change.
- [Risk] Provider-specific concepts may leak into dashboard APIs. -> Mitigation: map Codex/Claude details into provider-agnostic session, command, approval, and event fields before persistence.

## Migration Plan

1. Introduce domain contracts for agent sessions, runtime events, command records, approval requests, runtime capabilities, and child-session requests.
2. Add persistence and API surfaces for session snapshots and control actions.
3. Implement a mock runtime adapter that can request approval, receive approve/reject/cancel actions, and emit deterministic events for tests.
4. Adapt Codex Local behind the session interface, starting with capability detection and event streaming; gate approval support on verified CLI behavior.
5. Route provider-backed goal starts through the agent session manager when the selected provider is an interactive runtime.
6. Update dashboard goal detail to show session state and pending approval controls.
7. Rebase or revise `add-agent-live-status-model` and `add-multi-agent-run-tree` so they consume session/control-plane events and metadata.

Rollback is possible by keeping the existing one-shot provider path available behind provider settings. If session-mode Codex is disabled, Codex Local can fall back to the current direct-spawn completion behavior with reduced control features and explicit dashboard messaging.

## Open Questions

- Which Codex CLI mode can reliably support pausing for dashboard-mediated approval and then resuming the same session?
- Should the first Codex adapter use a PTY-style interactive process, JSONL non-interactive mode, or a hybrid capability-dependent strategy?
- Should rejected approval requests terminate the current session, return feedback to the agent, or let the user choose?
- How much of child-session spawn should be implemented immediately versus persisted as unsupported requests for future scheduler work?
