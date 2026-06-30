## Context

auto-agent is moving from a single visible run toward a supervised agent control plane. The immediate use case is Codex-first because Codex is the adapter available during early development, but the product direction is not Codex-only. The backend must own spawning, workspace creation, persistence, and merge side effects; an agent should express intent through a structured control event that can later become a real MCP tool or provider API call.

The Paperclip reference is useful for the shape of managed sessions and continuation, but this change keeps the MVP narrower: one active child, one delegation level, local git worktrees, and dashboard-visible state.

## Goals / Non-Goals

**Goals:**
- Let a supervisor spawn one backend-managed child session and automatically receive the child outcome.
- Preserve provider neutrality by making delegation a runtime control-plane contract, not a Codex-only API.
- Keep child writes isolated in a separate git worktree unless a `review_merge` child explicitly applies changes to the supervisor workspace.
- Let the supervisor decide when to spawn `review_merge`.
- Treat child failure, timeout, and cancellation as observations that the supervisor can reason about.
- Keep cancelled/terminal supervisor runs from force-cancelling active child processes; late results become detached/ignored.
- Expose delegation progress and merge outcomes through durable events and dashboard state.

**Non-Goals:**
- Parallel children, nested delegation, distributed queueing, remote sandboxes, budget accounting, or multi-user policy.
- Automatically merging worker output without an explicit supervisor-spawned `review_merge` child.
- Requiring a stable MCP transport in v1.

## Decisions

1. **Use tool-shaped structured control events for v1.**
   - Decision: the supervisor emits a structured delegation event in provider output; the backend validates it and performs the spawn.
   - Rationale: Codex CLI may not expose reliable custom MCP/tool calls under `codex exec --json` today, but the contract should be close enough to replace with MCP/API later.
   - Alternative considered: implement real MCP first. Rejected for v1 because it risks blocking the control-plane design on Codex transport details.

2. **Backend owns side effects.**
   - Decision: worktree creation, session spawn, status persistence, cancellation marking, merge checkpointing, and verification live in backend services.
   - Rationale: providers should not directly mutate project state outside the authority granted by the runtime.
   - Alternative considered: ask the model to run all git/session commands. Rejected because the user cannot reliably track or recover side effects.

3. **Limit v1 to one child and depth one.**
   - Decision: a supervisor may have at most one active child; children cannot spawn children.
   - Rationale: this makes lifecycle, UI, and recovery behavior testable before expanding fan-out.
   - Alternative considered: general DAG orchestration. Deferred until the basic loop is stable.

4. **Use isolated git worktrees for worker children.**
   - Decision: `worker` children get read/write access only inside their child worktree.
   - Rationale: this avoids corrupting the supervisor workspace while still allowing real file edits.
   - Alternative considered: same-workspace child writes. Rejected because failed or cancelled child work can leave the main workspace ambiguous.

5. **Use a dedicated `review_merge` role for applying work.**
   - Decision: the supervisor may spawn `review_merge` after inspecting worker results. `review_merge` can read child output and write to the supervisor workspace.
   - Rationale: review and merge have different authority from implementation work.
   - Alternative considered: automatically merge after worker success. Rejected because the supervisor should judge timing, risk, and whether review is needed.

6. **Treat child outcomes as continuation observations.**
   - Decision: success, failure, timeout, cancellation, and merge outcomes resume the supervisor if possible; otherwise the backend starts a fresh continuation session with summarized context.
   - Rationale: provider resume support varies, and delegation should not depend on one adapter's perfect session resume.
   - Alternative considered: fail the parent run on child failure. Rejected because failed child work can be useful information.

7. **Do not force-cancel children when the supervisor is cancelled.**
   - Decision: active children continue; when they finish, their result is stored as detached/ignored if the parent is terminal.
   - Rationale: killing a writing process can create project errors, and preserved output may still be useful for audit.
   - Alternative considered: cascade cancel. Deferred until there is a safe process cancellation and cleanup model.

## Risks / Trade-offs

- [Structured output is brittle] -> Validate a strict JSON schema, write rejection events, and keep prompts/tool descriptions deterministic.
- [Child worktrees can leak disk state] -> Persist worktree paths and add cleanup tasks after outcomes are accepted or ignored.
- [Review merge can damage supervisor workspace] -> Require clean workspace checks, pre-merge checkpoints, fixed tests, and automatic revert on failed tests.
- [Fresh continuation may lose nuance when true resume is unavailable] -> Include child summaries, event history, and artifact references in the continuation prompt.
- [One-child limit may feel restrictive] -> Keep the limit explicit and testable, then expand after v1 behavior is stable.

## Migration Plan

1. Add domain and persistence fields for delegation role, parent session, worktree path, child status, merge outcome, and detached/ignored result state.
2. Add backend services for delegation validation, worktree creation, child spawning, supervisor continuation, and merge checkpoint verification.
3. Add durable event types for requested, started, completed, failed, detached, merge-applied, merge-reverted, and verification-failed states.
4. Add dashboard/API read models for session tree and merge outcome display.
5. Roll back by disabling delegation control-event handling; existing single-run behavior remains available.

## Open Questions

- What exact fixed test command should be the default for this repository when `review_merge` first lands?
- How long should completed child worktrees be retained before cleanup?
