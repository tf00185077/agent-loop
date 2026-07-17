# Tasks: Executable Acceptance Checks

TDD throughout: failing test first. Commit at the end of every task group.
Reused machinery: frozen-criteria persistence (managed-task-repository),
attestation allowlists (delivery path), worktree service (baseline checkout),
sanitization helpers, durable criterion outcomes.

## 1. Check contract shape and freezing

- [x] 1.1 Failing tests: task-list validation accepts a valid check (kind/command/timeout/protectedPaths), rejects malformed ones with teaching reasons
- [x] 1.2 Domain type: optional `check` on `TaskAcceptanceCriterion`; control-event validation in `delegation-control-event.ts`
- [x] 1.3 Persistence: check definitions stored with frozen criteria; restated checks ignored via the existing mutation-ignored path; restart test
- [x] 1.4 Full suite + typecheck green; commit

## 2. Check runner and review-time execution

- [x] 2.1 Failing test: a checked criterion's command executes in the worker worktree at review dispatch; exit 0 stamps PASS, nonzero stamps FAIL, output sanitized and truncated in a durable execution record
- [x] 2.2 Check-runner service (spawn with timeout via killProcessTree; per-attempt execution records in managed-task-repository)
- [x] 2.3 Wire into the review-merge dispatch path before the judge starts; judge packet includes the execution table; unrunnable/timeout checks record `check.execution_failed` and fail closed
- [x] 2.4 Full suite + typecheck green; commit

## 3. Baseline discrimination (red-green / regression)

- [x] 3.1 Failing tests: red_green passing on baseline is rejected with a teaching reason; genuine red→green passes; regression requires baseline-green and candidate-green; failing regression baseline is a contract error that does not charge the retry budget
- [x] 3.2 Baseline execution via an ephemeral worktree at the worker's branch base; reclaimed by the existing orphan-reclaim path
- [x] 3.3 Full suite + typecheck green; commit

## 4. Protected paths and judge precedence

- [x] 4.1 Failing tests: attested diff touching protectedPaths is rejected naming the files; judge PASS over an executed FAIL is overridden durably and the attempt rejected; prose-only criteria behave exactly as before
- [x] 4.2 Protected-path gate against attested files before delivery preparation; `check.judge_overridden` durable event; acceptance precedence in the review path
- [x] 4.3 Full suite + typecheck green; commit

## 5. Prompt contract, dashboard, and closeout

- [ ] 5.1 Supervisor prompt: check authoring guidance and examples (informational; note red-green semantics and protected paths)
- [ ] 5.2 Dashboard timeline renders check executions (kind, exit, duration) on the attempt
- [ ] 5.3 Live smoke per CLAUDE.md: managed goal whose contract carries a red_green check; observe execution records and one vacuous-check rejection in the durable timeline; record in `verification.md`
- [ ] 5.4 Sync delta specs and archive the change
