## Context

Provider setup currently separates three related actions: choose a Codex Local model, save settings, then manually test the connection. In practice the connection test is more than a passive check: it runs the same Codex CLI execution path with a small prompt, proving that the command path, saved model label, authentication/session state, and last-message output path work together. Users can otherwise save a model that looks valid but only discover timeout/auth/model failures after starting a goal.

Run observability is also incomplete in the dashboard. Runs already persist `provider` and `model`, and provider-backed events include metadata in event data, but the UI mainly shows event type and message. When mock and Codex runs overlap or a late Codex timeout arrives after a mock completion, the timeline is hard to reason about.

## Goals / Non-Goals

**Goals:**
- Automatically run the existing Codex Local connection test after the user saves Codex Local provider settings with a command path.
- Treat the auto-test as validation of the exact saved model label/default selection.
- Keep manual testing available as an explicit retry/debug action.
- Display provider/model metadata in goal detail and timeline where the backend has it.
- Keep all provider execution behind backend APIs and avoid exposing credentials.

**Non-Goals:**
- Auto-test Claude Local; there is no Claude connection-test control in the current UI.
- Run a connection test on every model dropdown change before save.
- Add new credential storage, OAuth flows, or dashboard-side provider execution.
- Add dedicated run query APIs unless implementation finds timeline-only data insufficient.
- Fix the separate background-run race where a late provider failure can overwrite a terminal goal.

## Decisions

### Decision: Auto-test after a successful save
After the user clicks Save for Codex Local settings, the dashboard will persist the selected provider/model/command path first. If the saved provider is Codex Local and a command path exists, it will immediately call the existing `/api/provider-settings/test` endpoint and render the test progress/result in the same provider setup panel.

Why: this validates exactly what future goal starts will read from SQLite. It also avoids spawning a Codex process for every transient dropdown selection.

Alternative considered: test immediately on model selection change. Rejected for the MVP because it can spawn multiple long-running Codex CLI processes while the user is still exploring the picker, increasing timeout/race confusion.

### Decision: Reuse the existing test endpoint
The auto-test will use the current backend `testCodexLocalConnection` path rather than a new endpoint. The endpoint already sanitizes status, updates persisted provider status, and uses the same provider adapter boundary as goal execution.

Why: this keeps one source of truth for Codex readiness classification and credential redaction.

Alternative considered: add an endpoint that saves and tests in one transaction. Deferred because the current UI can sequence save then test, and backend persistence is local single-user SQLite.

### Decision: Render provider/model from event data first
The dashboard will display provider/model metadata from existing event data when present, especially `run.started`, provider-backed `agent.message`, and `error` events whose data includes a `runId`. Mock runtime events may be made more consistent by including `provider: "mock"` and `model: "mock-v1"` in run-level event data.

Why: the current MVP intentionally uses the event timeline as the observability surface and does not require dedicated run/step query APIs.

Alternative considered: add `GET /api/runs/:id` and fetch run metadata by run id. Deferred unless timeline metadata proves insufficient, because it expands the API surface.

## Risks / Trade-offs

- [Auto-test can add latency after Save] -> Keep the save result visible, show a separate Testing state, and leave the settings persisted even if the test fails.
- [Codex CLI test can timeout and confuse users] -> Render the sanitized failure state and preserve manual retry so the user can warm up or retest deliberately.
- [Timeline metadata may be absent on older events] -> Render metadata only when available and keep event messages readable without it.
- [Late provider failures can still overwrite terminal goals] -> Track as a related runtime guard issue, but keep this change focused on validation and observability.

## Migration Plan

No database migration is expected. Existing provider settings, runs, and events remain valid. New UI rendering should tolerate missing metadata on historical events.

Rollback is straightforward: remove the auto-test call after save and hide provider/model metadata rendering. Existing manual test and saved settings behavior remain intact.

## Open Questions

- Should a failed auto-test block starting a goal, or only warn? The MVP should warn only, because existing behavior allows starting with saved settings and records failures durably.
