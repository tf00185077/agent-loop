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
- Review, merge, worktree creation, apply/revert, and fixed-test gates are out of scope for this core.
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
