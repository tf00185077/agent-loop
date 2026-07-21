## Why

The supervisor's working directory is a single global value (`supervisorCwd`,
defaulting to the server's `process.cwd()`). Every goal runs against that one
directory, so a real-agent goal started from the dashboard operates on the
auto-agent repo itself — and because the runtime continuously writes its own
committed database (`data/auto-agent.sqlite`) into that repo, the delivery
cleanliness gate sees the workspace as dirty (`M data/auto-agent.sqlite`), fails
the task, and the goal wedges. Callers need to point a goal at a clean target
directory instead, chosen when they create the goal.

## What Changes

- A goal gains an optional **`workspace`**: the absolute directory the supervisor
  and its workers operate in. It is set at goal creation (dashboard + API),
  stored on the goal, and defaults to the server's configured default (today's
  `supervisorCwd`) so existing behavior is unchanged.
- The backend **validates** a supplied workspace before accepting the goal: it
  must be an existing, absolute directory path; a non-existent path, a file, or a
  relative path is rejected with a safe reason. (Whether it must be a git repo is
  an open question — see design.)
- The manager **resolves the goal's workspace once** and threads it through every
  place that today reads the global `state.supervisorCwd` — worktree
  create/remove (`parentCwd`), OpenSpec scaffold/validate/archive, git and check
  commands, and path sanitization — so all of a goal's work happens in its own
  directory.
- The dashboard **create-goal form** gains a Workspace field; the goal detail
  view shows the resolved workspace.
- The policy is caller-owned and read-only to the supervisor (like
  `confirmationPolicy`): no control block can read or change a goal's workspace.

**Non-goals**

- No workspace picker/browser UI (free-text absolute path in this change), no
  per-run or per-task workspace overrides, no remote/sandboxed workspaces.
- Not changing the delivery cleanliness check itself (excluding the runtime DB
  from that check is a separate, complementary fix); this change lets a caller
  sidestep it by targeting a clean directory.
- No migration of existing goals — a null workspace keeps using the server
  default.

## Capabilities

### New Capabilities

_None — this extends existing goal and orchestration capabilities._

### Modified Capabilities

- `dashboard-goal-lifecycle`: the create-goal flow accepts a workspace; goal
  detail surfaces the resolved workspace.
- `supervisor-goal-orchestration`: the supervisor and its workers run in the
  goal's workspace rather than a single global directory; the workspace is
  caller-owned and not settable by any control block.
- `goal-state-persistence`: a goal durably carries its workspace.

## Impact

- `src/domain/`: `Goal` + `CreateGoalInput` gain `workspace`.
- `src/persistence/`: `goals` table gains a nullable `workspace` column; repo
  read/write; migration.
- `src/backend/routes/goals.ts`: create endpoint accepts and validates
  `workspace`.
- `src/runtime/agent-session/agent-session-manager.ts`: resolve the goal's
  workspace at session start and replace `state.supervisorCwd` reads with the
  per-goal value carried on the session context; recovery/reconciliation paths
  use the goal's workspace too.
- `src/dashboard/`: create-goal form field + api client type; goal detail display.
