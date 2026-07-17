## ADDED Requirements

### Requirement: Change archive readiness uses durable lineage
The system SHALL evaluate the active change's registered task closure through the shared durable lineage projection before archiving. A valid split parent SHALL be satisfied only through all required leaf descendants, and any `invalid_split_lineage` gap SHALL block archive with the same semantics used by Goal completion.

#### Scenario: Accepted split descendants satisfy archive
- **WHEN** an active change contains a valid durably `split` parent whose complete required leaf closure is accepted and all other archive gates pass
- **THEN** the parent does not remain an undelivered archive blocker and the backend may archive the change

#### Scenario: Invalid lineage blocks archive and completion alike
- **WHEN** the active change contains a parent with children but without a valid split transition
- **THEN** archive and Goal completion both fail with `invalid_split_lineage` for the same affected tasks

### Requirement: Archive blockers are durably visible
The system SHALL persist a sanitized `change.archive_blocked` event for every attempted active-change archive that fails a precondition. The event SHALL name the change, a stable blocker type, bounded affected logical task identifiers when applicable, and a safe reason; an archive attempt SHALL never return silently.

#### Scenario: Undelivered task blocks archive
- **WHEN** the backend attempts to archive an active change whose durable leaf closure contains an unaccepted task
- **THEN** it records `change.archive_blocked` with blocker type `undelivered_task` and the affected logical task identifier

#### Scenario: Invalid lineage blocks archive visibly
- **WHEN** the backend attempts to archive an active change with an invalid durable lineage
- **THEN** it records `change.archive_blocked` with blocker type `invalid_split_lineage`, the affected tasks, and the stable lineage reason

#### Scenario: Unmerged evidence remains visible
- **WHEN** all task lineage is satisfied but attested worker changes remain unmerged
- **THEN** the backend records `change.archive_blocked` with blocker type `unmerged_changes`

### Requirement: OpenSpec archive mutations remain backend owned
The system SHALL reserve OpenSpec archive and main-spec synchronization mutations to backend operations. A provider-controlled Worker or spec-writer candidate that adds, removes, or modifies an archive directory, modifies main specs as an archive/sync side effect, or deletes active-change artifacts SHALL be rejected by a deterministic backend path validator and SHALL NOT be delivered.

#### Scenario: Worker runs an archive command
- **WHEN** a Worker candidate deletes the active change and creates or modifies its dated archive or synchronized main specs
- **THEN** the backend records a reserved-path rejection and does not allow Judge acceptance to authorize delivery of that candidate

#### Scenario: Spec writer edits active artifacts only
- **WHEN** a spec writer adds or modifies required artifacts inside the active change without touching reserved archive/sync paths or deleting active artifacts
- **THEN** the candidate remains eligible for the existing structural validation and review-merge gates

#### Scenario: Backend archives an eligible change
- **WHEN** all archive gates pass and the backend invokes its internal archive operation
- **THEN** the backend may move the active change and synchronize main specs under backend authority

#### Scenario: Database-backed archive capability is unavailable
- **WHEN** a database-backed Goal reaches archive readiness but the workspace service cannot prepare a durable archive identity
- **THEN** the backend records `change.archive_blocked` with blocker type `archive_capability_unavailable`
- **AND** it does not invoke the legacy archive path, emit `change.archived`, or activate the next change

### Requirement: Backend archive reconciliation is write-ahead and fail closed
The system SHALL persist a Goal/change-scoped archive operation intent containing the exact source, dated target, validated manifest digest, and workspace checkpoint before filesystem or Git mutation. It SHALL finalize `change.archived` only after the exact target and backend Git result are verified, and SHALL reconcile a retry idempotently only from that intent.

#### Scenario: Restart before archive move
- **WHEN** restart finds a pending intent whose matching source exists, target is absent, and manifest/checkpoint still match
- **THEN** the backend continues the recorded archive operation without creating a second intent or target

#### Scenario: Restart after move before durable finalization
- **WHEN** restart finds a pending intent whose source is absent and exact target exists with the recorded digest
- **THEN** the backend proves exactly one coherent source-to-target archive commit between the recorded checkpoint and current HEAD, or completes and verifies that commit
- **AND** it records exactly one terminal archive operation and `change.archived` event

#### Scenario: Archive workspace contains unrelated state
- **WHEN** archive preparation finds unrelated dirty or staged paths, or the candidate archive commit contains any path outside the exact source-to-target move
- **THEN** the backend fails closed without committing the unrelated state or finalizing the archive operation

#### Scenario: Archive manifest changes after preparation
- **WHEN** source or dated-target content changes after durable archive preparation and before the backend commit is finalized
- **THEN** the backend recomputes the canonical target manifest and verifies the unique archive commit tree against the recorded digest
- **AND** any mismatch blocks finalization and next-change activation

#### Scenario: Pending archive commit identity is ambiguous
- **WHEN** zero, multiple, conflicting, or recorded-SHA-mismatched archive commits exist between the pre-archive checkpoint and current HEAD
- **THEN** reconciliation durably blocks and does not adopt current HEAD as the archive commit identity

#### Scenario: Finalized archive is retried
- **WHEN** archive is requested again for a terminal operation whose exact target and digest remain present
- **THEN** reconciliation is an idempotent no-op and does not create a duplicate archive event or directory

#### Scenario: Archive topology is ambiguous
- **WHEN** source and target both exist, neither exists, multiple matching archives exist, digest/path/checkpoint differs, or a target exists without a matching durable intent
- **THEN** the backend records `change.archive_blocked` with blocker type `archive_state_ambiguous` and performs no adoption, move, commit, activation, or Goal transition

#### Scenario: Restart lacks durable archive preparation capability
- **WHEN** restart finds a database-backed active change with no archive operation and the workspace service cannot prepare durable archive identity
- **THEN** the backend records `change.archive_blocked` with blocker type `archive_capability_unavailable`, leaves the Goal blocked, and starts no provider
