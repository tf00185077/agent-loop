# Verification — role-model-dropdowns

## Automated tests (render assertions on the exact markup the browser gets)

- `src/dashboard/ProviderSetup.test.tsx` — 18/18 pass, including three new
  `renderToStaticMarkup` tests on `RoleAssignmentsEditor`:
  - a `codex-local` role renders a model `<select>` with a "Provider default"
    option and the catalog models (`value="gpt-5-codex"`, `GPT-5 Codex`), and **no
    command-path field**.
  - a `claude-local` role renders a model `<select>` with the curated aliases
    `opus` / `sonnet` / `haiku`, and no command-path field.
  - a `codex-local` role with no loaded catalog falls back to a text input (role
    stays selectable), still with no command-path field.
- `npm run typecheck` — clean. `npm test` — 504 pass, 0 fail, 14 skipped.

Because these are server-render assertions on the concrete HTML, they verify the
actual DOM the dashboard produces. A visual eyeball is available via
`npm run dev` (Provider setup → Child agent roles): a Codex role shows the model
catalog dropdown, a Claude role shows opus/sonnet/haiku, and no command-path input
appears for any role.

## Scope

Dashboard-only. No backend, persistence, or domain-type change: `RoleAssignments`
still stores an optional model label and command path; the editor simply
constrains the model to a provider-appropriate dropdown and stops surfacing the
command path (persisted `null`, backend auto-detects). Claude has no
model-discovery API, so its dropdown uses the stable tier aliases; Codex reuses
the live `codex debug models` catalog already loaded by the panel.
