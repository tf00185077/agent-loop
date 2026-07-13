# Verification: add-role-agent-assignments

## Automated verification (2026-07-13)

- `npm test`: 384 tests, 0 failures (settings persistence round-trip, API
  validation, resolver unit suite, manager dispatch/downgrade/caching,
  dashboard role controls).
- `npx tsc --noEmit`: clean.
- `openspec validate add-role-agent-assignments --strict`: valid.

## Live mixed-provider smoke (task 5.3, 2026-07-13)

Goal `5f1c1ace-c427-423f-9f00-12ea95a4d3d7`: **Codex supervisor
(`gpt-5.5`) + Claude worker** via a saved `roleAssignments.worker =
{provider: "claude-local"}`, analysis-only single-task goal (haiku via
`managed_task.result`, no file changes). Completed end to end, and
exercised far more of the stack than planned:

- `delegation.started` events carry `childProvider=claude-local`; child run
  rows record `claude-local` while the supervisor runs stayed `codex-local` —
  the resolved-agent evidence requirement, verified against real providers.
- Claude workers **failed three times** (`Claude managed session exited with
  code 1: no stderr`) — a real environment flake, which triggered the
  acceptance-contract machinery exactly as designed: rejection lineage
  accumulated, the attempt budget tripped the **narrowing rule**, the
  supervisor split to `task-1a` with criterion `A1a`, and the next Claude
  worker succeeded with a contract-compliant structured result (three-line
  haiku as criterion evidence, no claimed files).
- Goal completed with an accurate supervisor summary; no unbounded retry, no
  stranding, all recovery visible in the durable timeline (59 events).

## Known issues / follow-ups

1. **Claude print-mode flakiness**: intermittent exit code 1 with empty
   stderr from `claude --print` (prompt piped via stdin through the cmd.exe
   shim). Three failures then a success with the same invocation. Candidate
   fixes: pass the prompt as an argument, capture `--output-format json`
   diagnostics, or add a bounded in-adapter retry for silent nonzero exits.
2. Role resolution caches per goal in memory (consistent with the other
   registries); restart re-resolves — acceptable, documented.
3. The downgrade path was covered by unit tests but not exercised live in
   this run (Claude capability probe passes on this machine).
