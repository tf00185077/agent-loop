## Context

Provider setup currently persists a selected provider/model through Save, and goal start reads saved provider settings from SQLite. This makes saved settings both the UI default and the execution source. Users expect the model currently selected in the provider setup panel to be the one used when they press Start, even if they did not press Save.

The clean model is to separate saved defaults from per-run execution input: saved provider settings initialize the UI, while the start request may include a provider override that applies only to the new run.

## Goals / Non-Goals

**Goals:**

- Let the dashboard start a goal with the currently selected provider/model state without requiring Save.
- Add a provider-agnostic per-run override shape to the start-goal request.
- Prefer the per-run override over saved provider settings for that run.
- Preserve saved provider settings as defaults and as fallback when no override is provided.
- Record actual provider/model metadata used by the run.
- Sanitize override command paths with the same rules used for saved settings.

**Non-Goals:**

- Do not remove the Save action.
- Do not silently auto-save every provider/model selection change.
- Do not store provider credentials or expose secret material in start requests, responses, or event data.
- Do not implement multi-user provider profiles.

## Decisions

1. Use a per-run provider override in `POST /api/goals/:id/start`.

   The dashboard will send the currently selected provider state as an optional request body. If present, the backend uses it for this run only. If absent, the backend keeps the existing saved-settings behavior.

   Alternative considered: auto-save on model dropdown change. That would reduce backend changes, but it hides persistence side effects and still conflates UI selection with saved defaults.

2. Define the override as a provider union, not a Codex-only shortcut.

   The start body should support mock, Codex Local, and Claude Local shapes now, and leave room for future provider kinds. This avoids hard-coding the feature to Codex model selection.

   Alternative considered: add only `modelLabel` to the start request. That would be ambiguous when the selected provider is not Codex and would not solve command path selection.

3. Sanitize and validate override settings before runtime selection.

   The backend should reuse the same non-sensitive provider settings types and command path sanitization policy before constructing a runtime. The dashboard must not send access tokens or secret command arguments.

4. Run metadata records actual execution values.

   The run and event metadata must reflect the provider/model chosen by the override when one is supplied. Saved settings remain visible as defaults, not proof of what a specific run used.

## Risks / Trade-offs

- [Risk] Users may think Start changed the saved default. -> Mitigation: keep Save as the only persistent action and ensure provider setup state is clear in UI copy/control behavior.
- [Risk] Start request body may carry unsafe command text. -> Mitigation: sanitize override command paths and reject or redact secret-like arguments consistently.
- [Risk] Existing clients call start with no body. -> Mitigation: keep the body optional and preserve saved-settings fallback.
- [Risk] Provider setup and goal detail components may need shared state. -> Mitigation: lift provider selection state to the dashboard shell or pass a start override builder to goal detail.
