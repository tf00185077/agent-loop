## ADDED Requirements

### Requirement: Orphaned worker worktrees are reclaimed on startup

The system SHALL reclaim, at backend startup, the worker worktrees it durably
recorded for sessions whose owning goal is terminal (`failed`, `completed`,
`blocked`, or `cancelled`), removing each from disk through the worktree service
and recording a durable event for each reclaim. The reconciliation SHALL be
idempotent (an already-absent worktree is a successful no-op), SHALL operate only
on worktree paths durably recorded on agent sessions (never an arbitrary
filesystem path), SHALL leave worktrees of non-terminal goals untouched, and
SHALL NOT fail startup — a removal error is recorded durably and startup
continues.

#### Scenario: Terminal-goal worktree is reclaimed

- **WHEN** startup reconciliation finds a recorded worktree for a session whose
  goal is terminal and the worktree still exists on disk
- **THEN** the backend removes the worktree through the worktree service and
  records a durable reclaim event

#### Scenario: Non-terminal-goal worktree is left untouched

- **WHEN** startup reconciliation finds a recorded worktree for a session whose
  goal is not terminal
- **THEN** the backend does not remove that worktree

#### Scenario: Already-absent worktree is a durable no-op

- **WHEN** startup reconciliation processes a recorded worktree that is already
  gone from disk
- **THEN** the reconciliation completes successfully and records the reclaim as a
  no-op without raising an error

#### Scenario: Removal failure does not fail startup

- **WHEN** removing a recorded worktree fails
- **THEN** the backend records the failure durably and startup continues without
  throwing
