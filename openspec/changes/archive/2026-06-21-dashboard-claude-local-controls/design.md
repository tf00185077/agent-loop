## Context

The `claude-local` backend provider and settings already exist; only the dashboard provider setup had not been extended, so Claude Local was unreachable from the screen. This change is dashboard-only and documents the controls retroactively after they were implemented and verified live in the browser.

## Goals / Non-Goals

**Goals:**
- Make Claude Local selectable in dashboard provider setup with model label + command path inputs and a Detect control.
- Keep the status wording CLI-aware (Claude vs Codex).
- Reset the model label on provider switch so labels do not leak across providers.

**Non-Goals:**
- Claude model catalog picker and Claude connection test controls (deferred, matching the backend scope).
- Any backend or persisted-schema change.

## Decisions

### Decision: Reuse the presentational `ProviderSetupPanel`, add a Claude branch
The Claude section mirrors the Codex section minus the catalog and connection-test controls. The shared status box and status line are parameterized by the selected provider so the CLI name (Claude/Codex) and login command render correctly.

- **Why**: smallest change that keeps one panel component; avoids a parallel component.

### Decision: Reset model label in `handleProviderChange`
On provider switch, restore the saved label when the new provider matches the saved provider; otherwise reset to that provider's default (`mock-v1` for mock, blank = CLI default for a CLI provider).

- **Why**: prevents a stale label (e.g. `mock-v1`) being saved as another provider's model. A blank label already means "CLI default" end to end.

## Risks / Trade-offs

- [Free-text Claude model input allows typos] → Acceptable for now; a Claude model catalog picker is deferred. A blank value safely means "Claude CLI default".

## Open Questions

- None. Claude catalog/connection-test UI remains deferred to a later change.
