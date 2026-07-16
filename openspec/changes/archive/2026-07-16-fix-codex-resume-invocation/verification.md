# Verification — fix-codex-resume-invocation

## Root cause (from a real run)

The durable timeline of a real Codex goal showed:
`Codex managed session exited with code 2: error: unexpected argument '--sandbox' found …
Usage: codex exec resume --skip-git-repo-check --json <SESSION_ID> [PROMPT]`.
`codex exec resume` has no `--sandbox` flag (only plain `codex exec` does), so every
resume exited nonzero; the adapter surfaced `session.failed`, Phase 3b's catch never
fired, and the goal was force-failed with no retry.

## Real-CLI confirmation of the fix

Against the real Codex CLI (v0.144):
- `codex exec resume --help` → `-c/--config <key=value>` exists; there is no
  `-s/--sandbox`.
- Dry run `echo "" | codex exec resume <uuid> -c sandbox_mode=workspace-write
  --skip-git-repo-check --json -` → "No prompt provided via stdin", i.e. the args
  **parse cleanly** (it got past parsing to prompt validation) — confirming the
  corrected invocation.

## Automated tests

- `src/runtime/providers/codex/codex-session-resume.test.ts` — 4/4 pass:
  - the resume args now use `-c sandbox_mode=workspace-write` and contain no
    `--sandbox`; fresh args unchanged.
  - a failed resume attempt (session runner throws when `resumeSessionId` is set)
    falls back to a fresh run and does NOT surface `session.failed`; the fresh
    session completes.
- `npm run typecheck` — clean. `npm test` — 506 pass, 0 fail.

## Re-running the previously failed goal

The goal that hit the bug is `failed` in `data/auto-agent.sqlite`. With the fix,
starting a new Codex goal and interrupting/restarting it should now resume via the
corrected `codex exec resume`; if resume ever fails, it degrades to a fresh
continuation instead of failing the goal. The old failed goal can be re-run fresh
(or reset to `interrupted` to let the next boot resume it).
