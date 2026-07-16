# Verification — wire-codex-session-resume (Phase 4b)

## Real-CLI syntax confirmation

Verified against the actual OpenAI Codex CLI (v0.144.0-alpha.4, the path the
project detects: the ChatGPT VS Code extension's bundled `codex.exe`):

- `codex exec --help` lists `resume  Resume a previous session by id or pick the
  most recent with --last` — so the capability probe's detection
  (`/resume a previous session/i`) reports `sessionResume: true` on the real CLI.
- `codex exec resume --help` → `Usage: codex exec resume [OPTIONS] [SESSION_ID]
  [PROMPT]`; `[PROMPT]` reads from stdin when `-` is used; `--json`,
  `--skip-git-repo-check`, `--sandbox`, `-m/--model` all apply. This matches
  exactly the args `buildCodexManagedSessionArgs` produces for a resume:
  `exec resume <id> --skip-git-repo-check --json --sandbox workspace-write [-m …] -`.

## Automated tests

- `src/runtime/providers/codex/codex-session-resume.test.ts` — 3/3 pass:
  - `buildCodexManagedSessionArgs` builds `exec resume <id> …` with a resume id,
    fresh args without.
  - the `resume` capability is derived from `sessionResume` (separate from
    approval resume).
  - the adapter forwards `resumeSessionId` to its session runner only when it
    reports the `resume` capability; otherwise it starts fresh.
- `src/runtime/agent-session/resume-interrupted-goals.test.ts` — added: `resumeInterruptedGoal`
  passes the interrupted goal's last persisted `providerSessionId` as
  `resumeSessionId`.
- Updated `codex-runtime-adapter.test.ts` for the approval/resume capability split.
- `npm run typecheck` — clean. `npm test` — 501 pass, 0 fail, 14 skipped.

## Not auto-verified (by design)

CI cannot run the real Codex CLI, and a full transcript-replay run consumes model
tokens and does real work, so it is **not** executed here. The command syntax and
capability detection ARE verified against the real CLI above; the remaining
end-to-end (start a Codex-backed goal, kill the backend mid-run, restart, and
observe the resumed supervisor replay its prior transcript) is a manual step for a
logged-in Codex environment. The `recovery.resumed` event records
`providerResume: true` when a session id was supplied, giving a durable signal to
confirm resume was attempted.

## Scope

Codex only. The Claude adapter still returns plain text with no session id (it
would need stream-json parsing to surface one), so `resumeSessionId` is a no-op
for Claude — the 3b fresh-continuation floor applies. No schema change.
