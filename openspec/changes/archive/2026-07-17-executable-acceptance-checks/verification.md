# Verification — executable-acceptance-checks

## Automated tests (real substrate)

- Full suite at every group commit; final: **693 tests, 679 pass, 0 fail, 14
  skipped**, typecheck clean (commits `0ade2d1`, `a33a06c`, `2f0bfe8`,
  `4ae1b31`).
- **Contract freezing**: valid checks normalize and round-trip; five malformed
  shapes rejected with teaching reasons; restated checks ignored via the
  existing mutation-ignored path; frozen checks survive reopen
  (delegation-control-event + managed-task-repository tests).
- **Review-time execution**: end-to-end manager test drives task_list(check) →
  worker → review-merge and proves the backend runs the command exactly once
  in the worker worktree with the frozen timeout, persists the execution
  record (criterion, target, exit, output), and the judge prompt carries the
  "Executed acceptance checks" table.
- **Runner**: real-spawn unit tests — exit codes and output captured;
  timed-out checks are torn down (process tree) and report `failedToRun`
  within the deadline; pipes are destroyed on timeout so an orphaned
  descendant cannot hang the host process (this exact hang was hit live under
  a sandbox blocking `taskkill` and is now regression-covered).
- **Red-green discrimination**: a check passing on the baseline is rejected
  with a teaching reason, never reaches the judge, and durably reopens the
  task; a genuine red→green records baseline exit 1 + candidate exit 0 and
  accepts; regression checks require baseline-green (a failing baseline is a
  contract error that leaves the attempt untouched and charges no budget) and
  accept on green/green.
- **Protected paths**: an attested diff touching a check's protectedPaths is
  rejected naming the file before any check runs (zero runner calls, no
  judge).
- **Judge precedence**: judge PASS over an executed FAIL emits a durable
  `check.judge_overridden` (naming both outcomes) and downgrades the accepted
  verdict to a rejected delivery with the task reopened.

## Live smoke

- Backend boot regression on this branch tip: API up, mock-provider goal
  created → started → `goal.completed` with a 14-event durable timeline.
  Dev SQLite reset afterwards.

## Scoped-down live surface (honest note)

A full codex-managed run exercising a red_green check end-to-end requires a
live supervisor LLM to author a contract with a check and a worker to write a
vacuous test on demand — non-deterministic, per the precedent noted in
`archive/2026-07-17-harden-supervisor-delegation-gates/verification.md`. The
deterministic check machinery (freezing, execution, discrimination,
protection, precedence) is proven against the same SQLite/worktree/spawn
substrate the live path uses by the tests above. The check runner itself
executes real processes in the unit tests. A live managed run with checks is
recommended as follow-up observation, not as a gate for this change.
