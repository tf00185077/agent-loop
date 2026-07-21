# supervisor-goal-orchestration Delta

## ADDED Requirements

### Requirement: Workspace cleanliness ignores the runtime database
Every workspace git-cleanliness gate that runs in a goal's supervisor workspace — delivery, integration, review-merge, OpenSpec scaffold/archive, and recovery — SHALL disregard changes to the runtime's own database file and its `-wal`/`-shm`/`-journal` sidecars when judging whether the workspace is clean, so a goal may run inside the auto-agent repository itself without the runtime's own live writes being seen as a dirty workspace. The ignored set SHALL be derived from the actual configured database path; any other modified or untracked path SHALL still make the workspace dirty.

#### Scenario: A goal runs inside the auto-agent repo
- **WHEN** a goal's workspace is the auto-agent repository and the runtime has written to its committed database during the run
- **THEN** the delivery, integration, review-merge, OpenSpec, and recovery cleanliness gates treat the workspace as clean with respect to those database files

#### Scenario: A real change still fails the gate
- **WHEN** a goal's workspace has an uncommitted change to any path other than the runtime database files
- **THEN** the cleanliness gate still reports the workspace dirty and names that path
