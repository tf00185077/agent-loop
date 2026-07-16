## Context

`RoleAssignmentsEditor` (in `ProviderSetup.tsx`) renders, per role: a provider
`<select>`, a free-text model `<input>`, and a free-text command-path `<input>`.
The main provider picker in the same file already renders a catalog `<select>`
for `codex-local` from `modelCatalog.models` (source: `codex debug models`), with
a text-input fallback when the catalog is unavailable. The Claude CLI (verified,
v2.1.207) has no machine-readable model-list command; its models are selected by
stable tier aliases (`opus`, `sonnet`, `haiku`). `RoleAssignmentsEditor` is
rendered inside `ProviderSetupPanel`, which already holds `catalogModels`.

## Goals / Non-Goals

**Goals:** role model as a provider-appropriate dropdown; command path hidden and
auto-detected. Dashboard-only.

**Non-Goals:** any backend/persistence/domain change; a Claude discovery API
(none exists); changing assignment resolution.

## Decisions

**1. Thread the existing catalog into the role editor.** Pass `catalogModels`
(and its loading/availability state) from `ProviderSetupPanel` into
`RoleAssignmentsEditor`. No new fetch — reuse the catalog the panel already loads.

**2. Provider-specific model options, graceful fallback.**
- `codex-local`: `<select>` with "Provider default" (`""`) + the catalog models
  (slug → displayName). If the catalog is unavailable/empty (e.g. the main
  provider is not Codex so it was never loaded), fall back to the existing text
  input so the role is never unselectable.
- `claude-local`: `<select>` with "Provider default" + a curated const of stable
  aliases `["opus", "sonnet", "haiku"]`. Static by necessity (no discovery API);
  robust because tier aliases always resolve to the latest of that tier.

**3. Remove the command-path input; persist `null`.** The `RoleAssignments`
type still carries an optional command path, but the editor no longer surfaces it
and `updateRole` keeps `commandPath: null`. Backend detection/self-heal already
resolves the real path, so nothing regresses.

## Risks / Trade-offs

- [Curated Claude alias list drifts] → Mitigated by using tier *aliases*
  (`opus`/`sonnet`/`haiku`), which are stable and always point to the latest of
  each tier; no per-version slug to maintain.
- [A codex-local role while the main provider is claude-local has no loaded
  catalog] → Falls back to the text input (never blocks selection); a later
  refinement could trigger a catalog load on demand.
- [Users who relied on per-role command-path overrides] → Removed from the UI in
  favor of auto-detect; the persisted field still exists if a future advanced
  view needs it.

## Migration Plan

Dashboard-only; no data migration. Existing saved role assignments keep their
stored model label (rendered as the selected option when it matches, otherwise the
saved value can still be shown). Rollback restores the text inputs.

## Open Questions

- Should a saved role model that is not in the current dropdown (e.g. an old slug)
  be shown as a "(saved)" option like the main picker does? Recommended yes for
  parity; low cost.
