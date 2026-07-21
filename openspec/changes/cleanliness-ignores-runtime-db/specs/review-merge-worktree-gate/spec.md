# review-merge-worktree-gate Delta

## MODIFIED Requirements

### Requirement: Clean supervisor workspace and checkpoint
The system SHALL require a clean supervisor workspace and checkpoint before review merge applies changes. In judging cleanliness the system SHALL disregard changes to the runtime's own database file and its `-wal`/`-shm`/`-journal` sidecars, so a workspace whose only pending changes are those files is clean; any other uncommitted or untracked path SHALL still make the workspace dirty.

#### Scenario: Workspace is clean
- **WHEN** review merge starts and the supervisor workspace is clean
- **THEN** the backend records a pre-merge checkpoint before allowing apply behavior

#### Scenario: Workspace is dirty
- **WHEN** review merge starts and the supervisor workspace has uncommitted or untracked changes outside the accepted checkpoint policy
- **THEN** the backend rejects or fails review merge before applying worker changes

#### Scenario: Only the runtime database changed
- **WHEN** review merge starts and the supervisor workspace's only pending changes are the runtime database file and its sidecars
- **THEN** the backend treats the workspace as clean, records the checkpoint, and the dirty safe reason (if any later) never lists those files
