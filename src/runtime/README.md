# Runtime

In-process agent runtime services live here.

Runtime code starts from persisted goals, writes durable events, and stays behind the backend API boundary.

Codex is the first managed runtime reference adapter because it gives the MVP
a concrete local CLI to harden. It is not the permanent provider boundary:
provider-neutral runtime interfaces should continue to own continuation,
capability, and observation contracts so other adapters can plug in without
copying Codex command syntax.

## Layout

- `agent-loop/`: planning, implementation, quorum voting, and loop orchestration.
- `providers/`: provider-neutral runtime wiring plus provider implementations.
- `providers/codex/`: Codex CLI detection, command resolution, connection testing, model catalog, and execution.
- `providers/claude/`: Claude CLI detection and execution.
- `cli/`: shared local CLI discovery and command path helpers.
- `mock/`: deterministic mock runtime for tests and local development.
- `safety/`: output sanitization helpers for streamed or persisted process text.

## Managed Delegation V1

Managed delegation v1 supports a narrow backend-owned worker handoff:

- A supervisor may request one active `worker` child at a time.
- Child sessions may not request children; maximum delegation depth is one.
- Worker children run in isolated local git worktrees.
- Review merge is an explicit supervisor-triggered `review_merge` child role after a worker result exists.
- Worker success is recorded for the supervisor; it does not automatically spawn review merge or apply changes.
- Child success, failure, timeout, and cancellation are recorded as observations for the supervisor.
- If the supervisor is terminal before a child result arrives, the result is stored as detached and does not continue the supervisor.

Providers request delegation with a structured runtime-event metadata block:

```json
{
  "delegationControlEvent": {
    "type": "managed_delegation.request",
    "role": "worker",
    "prompt": "Run focused tests and summarize the result.",
    "summary": "Run focused tests."
  }
}
```

The backend validates this provider-neutral shape before scheduling. Valid requests are persisted as durable delegation requests, started through the managed runtime adapter, and surfaced in the goal session snapshot. Malformed, unauthorized, duplicate active-child, and nested requests are rejected durably without spawning a child.

## Review Merge Gate

Review merge children have supervisor workspace authority, so the backend adds gates around them:

- A `review_merge` request must include `workerDelegationRequestId` for an existing worker result.
- The supervisor workspace must be clean before review merge starts.
- The backend records a pre-merge checkpoint from `git rev-parse HEAD`.
- A review-merge child may report apply evidence with `reviewMergeApplyOutcome` metadata.
- Claimed `merged` outcomes are accepted only after the backend runs the fixed command.
- The fixed command defaults to `npm test` and can be overridden with `AUTO_AGENT_REVIEW_MERGE_TEST_COMMAND`.
- If fixed tests fail, the backend resets to the checkpoint, cleans untracked files, verifies the checkpoint and clean status, then records `test_failed_reverted` or `revert_failed`.
- Other durable outcomes include `rejected`, `conflict`, `failed`, and `verification_failed`.

Worker worktrees are retained after child completion. Their labels and sanitized paths are persisted in session snapshots so a later cleanup workflow can remove accepted or abandoned worktrees deliberately.

On a verified backend delivery conflict, the manager creates one durable
integration attempt and routes an `integrator` child through the normal role
resolver. The child receives exact candidate/checkpoint identities, frozen
criteria, and a bounded allowed-file set. Its only authoritative output is one
`managed_integration.result` block. Backend Git checks create the resolved
candidate, then an immediate `review_merge` child must judge that exact SHA.
The Supervisor resumes only after this sequential recovery finishes or fails.

## Durable Live Status

`projectAgentLiveStatus` produces the compact status shown by the dashboard. It
does not add a second state store: each request reconstructs the view from the
goal, managed sessions, pending approvals, delegations, managed tasks,
delivery records, and integration records already persisted in SQLite.

Authority is evaluated in this order: terminal goal, human approval/input,
integration recovery, active delegation, managed task review/delivery, then
session lifecycle. Sanitized events can supply only bounded summary text and
activity time; event prose cannot override structured state. The output keeps
`state` separate from the pipeline `phase` and caps normalized summaries at
500 characters. Raw prompts, commands, diffs, diagnostics, provider payloads,
and credentials are not part of the read model.
