## 1. Adapter input + resume args (TDD)

- [x] 1.1 Add `resumeSessionId?: string` to `AgentSessionStartInput`.
- [x] 1.2 Write a failing test for `buildCodexManagedSessionArgs`: with a `resumeSessionId` it builds `exec resume <id> --skip-git-repo-check --json --sandbox workspace-write [-m model] -`; without one it builds the existing fresh args.
- [x] 1.3 Implement the resume-args branch in `buildCodexManagedSessionArgs`.

## 2. Capability detection (TDD)

- [x] 2.1 Write a failing test that the Codex capability probe reports session-resume support when the help text contains the `resume` subcommand, and not when it is absent.
- [x] 2.2 Add `sessionResume` to the probe result, detect it from `codex exec --help`, and map the `resume` capability from it (approval stays mapped to `approvalResume`).

## 3. Adapter uses resume only when supported (TDD)

- [x] 3.1 Write a failing test: the Codex adapter passes `resumeSessionId` to its session runner only when it also reports the `resume` capability; otherwise it starts fresh.
- [x] 3.2 Wire the adapter `startSession` to include `resumeSessionId` in the session runner input when supported.

## 4. Manager supplies the persisted id (TDD)

- [x] 4.1 Write a failing test: `resumeInterruptedGoal` passes the interrupted goal's last persisted `providerSessionId` as `resumeSessionId` to `startManagedSession` (and passes none when absent).
- [x] 4.2 Thread `resumeSessionId` through `resumeInterruptedGoal` → `startManagedSession` → `adapter.startSession`.

## 5. Verify and commit

- [x] 5.1 Run focused tests for the changed files; all green.
- [x] 5.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [x] 5.3 Real-CLI verification: with the logged-in Codex CLI, confirm `codex exec resume <id> … -` resumes a prior session (syntax already verified via `exec resume --help`). Record findings — including that CI cannot run this — in this change's `verification.md`.
- [x] 5.4 Commit the task group with an imperative message naming the change (`wire-codex-session-resume`).
