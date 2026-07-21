# supervisor-goal-orchestration Delta

## ADDED Requirements

### Requirement: Goals run in their own workspace
The system SHALL run a goal's supervisor and its workers in the goal's workspace directory: worktree creation and removal, OpenSpec scaffold/validate/archive, git and acceptance-check command execution, and workspace-path sanitization SHALL all resolve to the goal's workspace, or to the server's default workspace when the goal has none. The workspace SHALL be caller-owned and unreadable and unchangeable by any control block, and the resolution SHALL be derived from the durable goal record so it holds across restart, recovery, and continuation.

#### Scenario: Work happens in the goal's workspace
- **WHEN** a goal with a workspace runs and creates a worker worktree or executes a command
- **THEN** the worktree and command use the goal's workspace as their parent directory

#### Scenario: Default workspace when none is set
- **WHEN** a goal with no workspace runs
- **THEN** its work uses the server's default workspace, unchanged from prior behavior

#### Scenario: Workspace is not settable by the agent
- **WHEN** a supervisor emits any control block attempting to read or change the workspace
- **THEN** the backend does not honor it as a workspace change and the goal keeps its caller-set workspace

#### Scenario: Recovery keeps the goal's workspace
- **WHEN** a goal is reconciled or resumed after a restart
- **THEN** its recovered work resolves to the same goal workspace it had before
