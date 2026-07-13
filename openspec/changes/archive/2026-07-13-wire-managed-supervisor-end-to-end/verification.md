# Verification: wire-managed-supervisor-end-to-end

## Automated verification (2026-07-13)

- `npm test`: 354 tests, 0 failures (includes new control-block, supervisor
  prompt, sequential-delegation/completion, Codex/Claude adapter, default
  server wiring, downgrade, and agent-loop gate/queue suites).
- `npx tsc --noEmit`: clean.
- `openspec validate wire-managed-supervisor-end-to-end --strict`: valid.

## Live Codex smoke (task 7.2, 2026-07-13)

Goal `f66b546f-4006-48d2-b97e-ecadc758f2f6` ("Smoke 2: two-note goal") ran
through the real Codex CLI (`codex.exe` from the VS Code extension, model
`gpt-5.5`) via `POST /api/goals/:id/start` with saved `codex-local` provider
settings and **no injected adapter**.

Observed durable timeline evidence (357 events):

- `supervisor.task_list` recorded from a fenced control block.
- `delegation.accepted/started/waiting_child` with `taskId=task-1` and later
  `taskId=task-2`; workers ran in isolated worktrees under
  `..\auto-agent-worktrees\child-<sessionId>`.
- Multiple `delegation.continuation_started` (fresh mode) after child results.
- Malformed/duplicate control blocks were rejected durably
  (`delegation.rejected`) and fed back into continuation prompts.
- Goal completed only on the explicit `managed_delegation.complete` block:
  `goal.completed` message "Delivered both smoke note tasks: …" with
  `runtimeEventType=supervisor.completed`.
- Both artifacts verified on disk with exact requested content:
  `docs/smoke-notes/alpha.md` = `alpha note`, `beta.md` = `beta note`
  (removed after verification; they were smoke artifacts, not product files).

An earlier smoke run (goal `df5b79d4…`) exposed a stranding bug — a
fresh-continuation supervisor whose process exited while its worker was still
running was marked `completed`, detaching the child result. Fixed in
`d489a5b` with a regression test; the second run confirmed the fix.

## Known rough edges observed in the live run (follow-up candidates)

1. **Continuation context is too thin.** Fresh continuations carry only the
   goal + latest worker observation, so the real supervisor re-announced the
   task list and re-delegated `task-1` several times before progressing to
   `task-2`. The run still converged within the continuation budget, but the
   continuation prompt should carry the durable task list and completed
   delegation summaries.
2. **Supervisor did some file work itself.** The final supervisor turn created
   the files in the supervisor workspace directly instead of requesting a
   `review_merge` child. Consider hard-enforcing review-merge when workers
   changed files (design open question now has evidence).
3. Codex emits `turn.completed` JSONL events the parser reports as
   unrecognized; harmless noise worth a parser entry.
