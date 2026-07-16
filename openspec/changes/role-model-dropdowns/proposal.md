## Why

The child-role assignment editor makes the user free-type a model label and
exposes a raw command-path input. That is error-prone (a typo'd model slug or a
wrong path silently degrades the run) and command paths are an implementation
detail users should not need to know. The main provider picker already presents
models as a catalog dropdown; the role editor should match, and the command path
should be auto-detected like the main provider's.

## What Changes

- The role model field becomes a **dropdown** instead of a text input:
  - `codex-local` roles: populated from the live Codex model catalog
    (`codex debug models`, the same source as the main picker), with a
    "Provider default" option; falls back to a text input when the catalog is
    unavailable.
  - `claude-local` roles: populated from a curated list of the stable Claude tier
    aliases (`opus`, `sonnet`, `haiku`) plus "Provider default" — the Claude CLI
    has no machine-readable model-list command, and these aliases are stable
    (always resolve to the latest of each tier).
- The role **command-path input is removed** from the UI; role command paths are
  auto-detected (persisted as `null`), exactly as the "Auto-detect" default
  already implied.
- The model catalog is threaded from the provider panel into the role editor.

Non-goals: no backend/schema change (`RoleAssignments` still stores an optional
model label and command path; the UI simply stops asking for the command path and
constrains the model to a dropdown); no Claude model-discovery API (none exists);
no change to backend assignment resolution or capability-gated fallback.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `role-agent-assignments`: refine "User-configured role assignments" so the user
  selects a role's model from a provider-appropriate dropdown and the command path
  is auto-detected rather than user-entered.

## Impact

- `src/dashboard/ProviderSetup.tsx` — `RoleAssignmentsEditor` renders a model
  `<select>` (Codex catalog / curated Claude aliases) and drops the command-path
  input; `ProviderSetupPanel` passes the catalog down.
- `src/dashboard/ProviderSetup.test.tsx` — updated coverage.
- No backend, persistence, or domain-type change.
