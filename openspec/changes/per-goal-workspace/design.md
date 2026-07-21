## Context

`supervisorCwd` is a single value on `SupervisorState` (`deps.supervisorCwd ??
process.cwd()`), read in ~30 sites in `agent-session-manager.ts`: worktree
create/remove (`parentCwd`), OpenSpec scaffold/validate/archive (`cwd`), git and
acceptance-check command execution, and `sanitizeArchiveReason` (which strips the
workspace path from safe reasons). Every site has the goal in scope — either
`input.goalId` (during a session's event pump) or `session.goalId` (during
recovery/reconciliation). So the value can become per-goal without changing call
shapes, only its resolution.

The immediate motivation: a goal run against the auto-agent repo has its
workspace flagged dirty by the runtime's own committed `data/auto-agent.sqlite`,
failing delivery. Letting the caller target a clean directory sidesteps it.

## Goals / Non-Goals

**Goals:**

- Per-goal workspace, caller-set at creation, backward compatible (null → server
  default), read-only to the supervisor, threaded through every workspace op.
- Deterministic validation of the supplied path at the backend boundary.

**Non-Goals:**

- Workspace browser UI, per-run/per-task overrides, remote/sandboxed execution,
  changing the cleanliness check, migrating existing goals.

## Decisions

**D1 — Workspace is a durable, caller-owned goal field.** `Goal.workspace: string
| null`; nullable `workspace` column on `goals`; set only via goal creation (and,
like `confirmationPolicy`, changeable only by a caller action, never a control
block). Null means "use the server default." Mirrors the `confirmationPolicy`
precedent end to end (domain → column → create route → dashboard field).

**D2 — Resolve per goal, keep a default on state.** Rename the state field to
`defaultWorkspace` (value unchanged: `deps.supervisorCwd ?? process.cwd()`) and
add `resolveGoalWorkspace(deps, state, goalId) = goalRepo.getById(goalId)?.workspace
?? state.defaultWorkspace`. Replace every `state.supervisorCwd` /
`input.state.supervisorCwd` read with this call. Alternative (a `Map<goalId,
string>` populated at session start) rejected: the goal row is already the durable
source, so resolving from it is simpler and restart-safe with no cache to seed.

**D3 — Validate at the create-route boundary.** When `workspace` is present it
MUST be a non-empty string, an absolute path, and an existing directory; otherwise
the create endpoint returns 400 with a safe reason. Validation lives in the
backend route (deterministic, not prompt). Existence is checked with `fs.statSync`
+ `isDirectory()`.

**D4 — Security posture for a local single-user MVP.** An arbitrary absolute
directory is accepted as long as it exists and is a directory; the agent then
operates there. This matches the product's local single-user scope. The proposal
does NOT add an allowlist or sandbox; that is called out as a risk and an open
question rather than silently assumed safe.

**D5 — Recovery and worktrees use the goal's workspace.** Startup
recovery/reconciliation and worktree reclamation already have `session.goalId`;
they resolve the goal's workspace the same way, so a resumed or reconciled goal
keeps operating in its own directory.

**Boundaries:** dashboard talks only to the create/detail endpoints; validation
and resolution are backend-only; SQLite owns the durable workspace; the provider
adapter is unaffected (it receives the resolved cwd as it does today).

## Risks / Trade-offs

- [Arbitrary path = the agent can run git/commands anywhere on disk] → For a
  local single-user tool this is the caller's own machine and choice; documented,
  not sandboxed. If multi-user/hosted ever lands, an allowlist is required — noted
  as an open question.
- [A workspace that is not a git repo] → worktree creation and git checks would
  fail at run time with durable events, not silently. Whether to reject
  non-git-repo workspaces up front is an open question (D-open).
- [Path with spaces / Windows backslashes] → store and pass verbatim; command
  execution already quotes paths. Add a test with a spaced Windows path.
- [Existing goals] → null workspace resolves to the server default; no migration,
  no behavior change.

## Migration Plan

Additive: nullable column (default null → server default), new optional create
field, resolution swap. No data migration. Rollback = revert; the column is
ignored by old code.

## Open Questions

- Should the backend require the workspace to be a **git repository** (since
  worktrees and delivery need git), rejecting non-repo directories at creation
  rather than failing later? Leaning yes for a clearer error, but it couples
  validation to git availability.
- Should there also be a configurable **server default workspace** setting
  (separate from the process cwd) so operators set a sane default without env
  changes? Deferrable; the null → cwd default is enough for this change.
