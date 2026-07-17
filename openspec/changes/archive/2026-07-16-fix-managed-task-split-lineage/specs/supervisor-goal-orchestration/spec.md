## ADDED Requirements

### Requirement: Goal completion and change archive share lineage semantics
The system SHALL use the shared durable task-lineage projection for every managed Goal completion evaluation. A split parent SHALL be satisfied only through its valid required leaf closure, and an invalid graph SHALL produce `invalid_split_lineage` with the same task IDs and reason that block the owning change's archive.

#### Scenario: Archive and completion inspect the inconsistent graph
- **WHEN** a parent has a persisted child but lacks a valid durable `split` transition
- **THEN** both the active-change archive attempt and Goal completion request fail closed with `invalid_split_lineage`
- **AND** neither gate interprets the parent as a delivered or ignorable non-leaf

#### Scenario: Valid split lineage completes through descendants
- **WHEN** a parent is durably `split`, its frozen descendant graph is valid, every required leaf is accepted, and every other completion gate passes
- **THEN** the parent is satisfied through those descendants for both archive and Goal completion

### Requirement: Existing blocked Goals require explicit lineage recovery
The system SHALL provide a local offline operator recovery whose default mode is read-only dry-run and whose apply mode requires a verified backup and the exact dry-run plan digest. Recovery SHALL be eligible only for a `blocked` Goal with continuation-exhaustion provenance, quiescent runs/sessions/task pipelines, no ambiguous migration diagnostic, a valid shared lineage projection, and one coherent change/workspace/Git recovery plan. Failed preconditions SHALL leave all state unchanged.

#### Scenario: Dry-run evaluates an incident-shaped Goal
- **WHEN** an operator targets an existing blocked Goal without apply authorization
- **THEN** the command reports bounded eligible repairs, archive reconciliation, lifecycle transition, blockers, and a deterministic plan digest without changing SQLite, files, Git, provider sessions, or Goal state

#### Scenario: Proven provider-created archive is adopted explicitly
- **WHEN** the active directory is absent, exactly one matching dated archive strictly validates, its manifest matches delivered evidence, Git history proves one coherent archive commit, all durable gates pass, and apply authorization matches the dry-run digest
- **THEN** recovery records operator authorization, a reconciled archive operation, and exactly one `change.archived` event without moving or rewriting the archive files

#### Scenario: Eligible blocked Goal is prepared for fresh continuation
- **WHEN** all authorized recovery steps commit successfully
- **THEN** the backend transitions the Goal from `blocked` to `interrupted`, clears only its terminal timestamp, preserves old runs/sessions/events/task evidence, and starts no provider work in the recovery command
- **AND** a later normal backend restart may use existing interrupted-Goal behavior to start a fresh durable-projection continuation

#### Scenario: Ambiguous blocked Goal stays blocked
- **WHEN** lineage, archive directories, manifests, Git provenance, pending pipeline state, terminal reason, backup, or plan digest is missing or ambiguous
- **THEN** recovery performs no partial write or workspace mutation and the Goal remains `blocked`

#### Scenario: Frozen-contract migration diagnostic is ambiguous
- **WHEN** the frozen-contract or split-lineage migration marker names a task in the selected Goal as ambiguous
- **THEN** recovery reports the normalized task diagnostic and remains read-only and ineligible even if the task is accepted and its current criteria pass

#### Scenario: Stopped-backend evidence is stale
- **WHEN** apply evidence does not bind the selected Goal to the exact pre-apply database digest and current workspace HEAD
- **THEN** recovery rejects apply as stale and performs no write

#### Scenario: Idempotent replay postconditions are incomplete
- **WHEN** an authorization row exists but the Goal is not interrupted, the authorized archive operation/SHA is missing or mismatched, or the uniquely cross-linked `change.archived` event is missing, duplicated, or tampered
- **THEN** replay fails closed instead of trusting the authorization row or reporting an idempotent success

#### Scenario: Idempotent replay workspace proof changed
- **WHEN** the authorized archive target is missing or modified, its source/target topology or manifest no longer matches, the workspace is dirty, or Git no longer proves the recorded coherent archive commit
- **THEN** replay fails closed without changing SQLite or reporting an idempotent success

#### Scenario: Restart cannot reset pending delivery
- **WHEN** interrupted-Goal reconciliation lacks a pending delivery's recorded clean checkpoint, lacks the reconciliation capability, or cannot restore the checkpoint
- **THEN** the backend records a durable recovery blocker, leaves the Goal non-resumable in `blocked`, and starts no provider continuation

#### Scenario: Ignored artifact prevents exact checkpoint proof
- **WHEN** a non-disposable supervisor workspace contains an ignored artifact outside the explicit protected local-input allowlist during pending-delivery reconciliation
- **THEN** the backend does not delete the artifact, records a durable reset blocker, and leaves the Goal non-resumable
- **AND** explicitly protected local inputs such as credentials, dependencies, and managed worktree roots are retained

### Requirement: Split-lineage repair does not redefine continuation policy
The system SHALL preserve the configured supervisor continuation maximum, the existing classification and increment behavior for completion-less and control-rejected turns, counter reset behavior, and terminal exhaustion diagnostics while applying this split-lineage repair.

#### Scenario: Continuation bound is unchanged
- **WHEN** a managed Goal encounters turns unrelated to the repaired lineage transition
- **THEN** continuation accounting and exhaustion behavior match the pre-change contract

#### Scenario: Lineage repair advances without a budget workaround
- **WHEN** the valid child set commits and its leaf descendants satisfy delivery
- **THEN** archive and completion advance from corrected durable state without adding, resetting, or bypassing a continuation budget
