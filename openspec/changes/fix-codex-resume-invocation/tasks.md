## 1. Correct resume args (TDD)

- [x] 1.1 Update the failing `buildCodexManagedSessionArgs` test: the resume args use `-c sandbox_mode=workspace-write` and do NOT contain `--sandbox`; fresh args are unchanged.
- [x] 1.2 Fix the resume branch of `buildCodexManagedSessionArgs` accordingly.

## 2. Resume→fresh fallback (TDD)

- [x] 2.1 Write a failing test: when the session runner throws on a resume attempt (resumeSessionId set), the adapter retries a fresh run (resumeSessionId null) and does not surface a terminal `session.failed`; when a fresh run throws, it does surface `session.failed`.
- [x] 2.2 Extract the per-run consumption into a local `runAttempt` generator and add the resume→fresh fallback in the Codex session event loop.

## 3. Verify and commit

- [x] 3.1 Run focused tests for the changed files; all green.
- [x] 3.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [x] 3.3 Real-CLI check: re-confirm `codex exec resume <id> -c sandbox_mode=workspace-write --skip-git-repo-check --json -` parses (already dry-verified). Record findings in this change's `verification.md`, including that the previously-failed goal can be re-run.
- [x] 3.4 Commit the task group with an imperative message naming the change (`fix-codex-resume-invocation`).
