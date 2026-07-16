## Why

Phase 4b's Codex resume invocation is broken against the real CLI: it passes
`--sandbox workspace-write`, but `codex exec resume` does not accept `--sandbox`
(only plain `codex exec` does), so every resume of a Codex goal exits code 2
("unexpected argument '--sandbox'"). Worse, the adapter surfaces that as a
`session.failed` event rather than throwing, so Phase 3b's best-effort catch never
fires and the whole goal is marked `failed` with no retry — observed on a real run.

## What Changes

- **Correct the resume args**: the resume branch of `buildCodexManagedSessionArgs`
  sets the sandbox via a config override `-c sandbox_mode=workspace-write` instead
  of `--sandbox workspace-write` (verified against the real Codex CLI v0.144:
  `codex exec resume <id> --skip-git-repo-check --json -c sandbox_mode=… -` parses
  and runs). Fresh `codex exec` keeps `--sandbox` unchanged.
- **Fall back to a fresh session when resume fails**: if the resume subprocess
  fails to start/exits nonzero, the Codex adapter retries the same continuation as
  a fresh (non-resume) session instead of failing. This fulfills the existing
  "resume is unavailable → fresh continuation" requirement and degrades a broken
  resume to Phase 3b's fresh-continuation floor rather than killing the goal.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `codex-managed-runtime`: refine "resumes when available" so resume uses a
  config-based sandbox override (not `--sandbox`) and falls back to a fresh
  session when the resume invocation fails.

## Impact

- `src/runtime/providers/codex/codex-runtime-adapter.ts` — resume args in
  `buildCodexManagedSessionArgs`; resume→fresh fallback in the session handle's
  event loop.
- `src/runtime/providers/codex/codex-session-resume.test.ts` — updated args test +
  a fallback test.
- No backend/schema change.
