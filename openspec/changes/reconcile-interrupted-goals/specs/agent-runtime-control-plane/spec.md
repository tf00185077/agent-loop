## ADDED Requirements

### Requirement: Restart-interrupted goals are reconciled to a resumable state

The system SHALL reconcile, on startup, each goal that has a non-terminal durable
agent session with no attached adapter process into a clean, consistent,
resumable durable state rather than force-failing it, and SHALL leave the goal in
a durable non-terminal `interrupted` status. Reconciliation SHALL:

- reset every pending delivery for the goal to its recorded clean checkpoint
  through the delivery reconciliation primitive, so git and the ledger agree and
  no candidate is double-applied or left unvalidated;
- durably interrupt every in-flight worker attempt (delegation requests that are
  requested, accepted, or running) and reset the owning managed task to a
  re-dispatchable `registered` state while preserving the frozen acceptance
  contract and the durable retry/narrowing counts, without counting the
  interrupted attempt as a substantive rejection or consuming the narrowing
  budget;
- record a durable recovery event summarizing what was reconciled.

The `interrupted` status SHALL be non-terminal, so an interrupted goal's
worktrees are not reclaimed by terminal-goal cleanup and the goal remains
eligible for later resume.

#### Scenario: Pending delivery is reset to its checkpoint on restart

- **WHEN** startup reconciliation finds a goal with a pending delivery whose
  supervisor workspace is ahead of the recorded checkpoint
- **THEN** the backend resets the supervisor workspace to the recorded clean
  checkpoint and records a durable reconciliation event, leaving no candidate
  applied

#### Scenario: In-flight worker attempt is interrupted and its task reset

- **WHEN** startup reconciliation finds a goal with a worker delegation still
  requested, accepted, or running and its managed task marked delegated
- **THEN** the backend durably interrupts the attempt and resets the task to
  `registered` with its frozen criteria and durable retry counts preserved, and
  the interrupted attempt is not counted as a substantive rejection

#### Scenario: Reconciled goal becomes interrupted, not failed

- **WHEN** startup reconciliation finishes for a restart-interrupted goal
- **THEN** the goal is left in a durable non-terminal `interrupted` status with a
  durable recovery event, rather than `failed`

#### Scenario: Idle interrupted goal is still reconciled cleanly

- **WHEN** startup reconciliation finds a goal with a non-terminal session but no
  pending delivery and no in-flight worker attempt
- **THEN** the goal is moved to a durable `interrupted` status with a durable
  recovery event and no workspace change
