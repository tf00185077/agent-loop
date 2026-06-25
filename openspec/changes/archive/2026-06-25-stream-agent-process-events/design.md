## Context

The backend already starts goal runs asynchronously and persists events to SQLite while runtimes execute. The dashboard, however, reads the timeline as a snapshot through `GET /api/goals/:id/events`, so users do not see progress until a refresh is triggered. Provider-backed paths also hide most spawned CLI process output: Codex currently ignores stdout and reads the final response from `--output-last-message`, while Claude accumulates stdout and returns only after process close.

The requested behavior is not polling. The dashboard should receive backend-pushed timeline updates while a goal is running. For CLI-backed providers, the backend should capture safe process output chunks where available and persist them as events so the live stream and durable timeline show the same observable progress.

## Goals / Non-Goals

**Goals:**

- Add a backend-pushed live event stream for one goal's timeline.
- Persist live runtime messages as durable events before pushing them.
- Capture local CLI provider stdout/stderr chunks where they represent useful agent progress.
- Keep the existing event snapshot endpoint as the source of truth for initial load and reconnect.
- Sanitize process output before storing or sending it to the dashboard.

**Non-Goals:**

- Do not implement polling, WebSockets, distributed pub/sub, or multi-user fan-out.
- Do not expose provider credentials, command secret arguments, auth cache contents, cookies, or tokens.
- Do not require a full interactive terminal emulator in the dashboard.
- Do not make dashboard code execute provider commands.

## Decisions

1. Use Server-Sent Events for the MVP live stream.

   SSE fits the current Express REST shape, streams server-to-dashboard updates over one HTTP response, and avoids a WebSocket dependency. The dashboard can open `EventSource` while a goal is running, append events as they arrive, and fall back to the snapshot endpoint on reconnect.

   Alternative considered: WebSockets. WebSockets are more general but add more connection lifecycle and protocol complexity than the local single-user MVP needs.

2. Persist before publish.

   Runtime and provider code will continue to write every meaningful event to SQLite first. The live stream publisher will send the persisted event shape after it has an id and timestamp. This keeps the live timeline consistent with refresh/reconnect behavior.

   Alternative considered: push transient chunks only. That would make live output richer, but users could lose messages after refresh and tests would need two separate timeline semantics.

3. Model provider process streaming as optional provider progress.

   A provider adapter can report sanitized process output chunks through a callback supplied by provider runtime. Claude can likely emit stdout chunks. Codex requires investigation because the current invocation ignores stdout and uses `--output-last-message`; implementation must verify whether Codex emits useful stderr/stdout progress or whether another supported non-interactive output mode is needed.

   Alternative considered: scrape the app terminal. That would couple runtime observability to the dev server terminal and would not work reliably in production or tests.

4. Keep final provider result behavior unchanged.

   Progress chunks are additional `agent.message` or provider-progress events. The provider runtime still records the final response or error using the existing completion/failure path.

## Risks / Trade-offs

- [Risk] Codex CLI may not emit useful streamable assistant text with the current `codex exec --output-last-message` invocation. -> Mitigation: implement a provider-level stream probe/test first and fall back to streaming durable lifecycle/progress events while preserving the final response.
- [Risk] Raw process output may include sensitive paths or credentials. -> Mitigation: reuse and extend sanitization before persisting or streaming chunks.
- [Risk] SSE clients can disconnect. -> Mitigation: dashboard reloads the durable snapshot on connect/reconnect and treats SSE as live continuation.
- [Risk] Duplicate events can appear if snapshot and stream overlap. -> Mitigation: deduplicate by event id in dashboard state.
