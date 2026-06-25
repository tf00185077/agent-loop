# Runtime

In-process agent runtime services live here.

Runtime code starts from persisted goals, writes durable events, and stays behind the backend API boundary.

## Layout

- `agent-loop/`: planning, implementation, quorum voting, and loop orchestration.
- `providers/`: provider-neutral runtime wiring plus provider implementations.
- `providers/codex/`: Codex CLI detection, command resolution, connection testing, model catalog, and execution.
- `providers/claude/`: Claude CLI detection and execution.
- `cli/`: shared local CLI discovery and command path helpers.
- `mock/`: deterministic mock runtime for tests and local development.
- `safety/`: output sanitization helpers for streamed or persisted process text.
