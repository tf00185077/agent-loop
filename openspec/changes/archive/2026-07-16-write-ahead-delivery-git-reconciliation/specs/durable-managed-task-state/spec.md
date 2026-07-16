## ADDED Requirements

### Requirement: Delivery intent is recorded before the supervisor mutation

The system SHALL persist a durable `pending` delivery record carrying the
candidate commit SHA and the clean supervisor checkpoint HEAD BEFORE it applies
that candidate to the supervisor workspace, and SHALL update that same record
(identified by the worker delegation) to its terminal outcome only after the
apply and fixed validation resolve. A crash between the supervisor mutation and
the terminal update therefore always leaves a durable pending record that names
the exact candidate and checkpoint, never an empty ledger.

#### Scenario: Pending intent precedes the cherry-pick

- **WHEN** the backend is about to apply an accepted candidate to the supervisor
  workspace
- **THEN** a durable delivery record with status `pending`, the candidate commit
  SHA, and the checkpoint HEAD exists before the supervisor workspace is mutated

#### Scenario: Terminal outcome updates the same record

- **WHEN** the apply and fixed validation of a delivery resolve
- **THEN** the backend updates the same worker-delegation delivery record to its
  terminal status without creating a second delivery record for that attempt

#### Scenario: Successful delivery is unchanged end to end

- **WHEN** a delivery runs to completion without interruption
- **THEN** the final delivery record and the resulting supervisor git state are
  the same as before write-ahead recording, with exactly one candidate commit

### Requirement: A pending delivery reconciles to its recorded checkpoint

The system SHALL provide a reconciliation of a pending delivery that consults
git ground truth and restores the supervisor workspace to the delivery's
recorded clean checkpoint HEAD, discarding any partial, unmerged, or unvalidated
cherry-pick left by an interrupted apply, so that a subsequent re-delivery starts
from the known-clean checkpoint and cannot double-apply the candidate or ship an
unvalidated commit. Reconciliation SHALL NOT itself re-apply or re-validate the
candidate.

#### Scenario: Interrupted apply is reset to the checkpoint

- **WHEN** a pending delivery is reconciled and the supervisor workspace is not
  at the recorded checkpoint HEAD (a partial or completed cherry-pick is present)
- **THEN** the reconciliation restores the supervisor workspace to the recorded
  checkpoint HEAD and verifies it is clean, leaving no candidate commit applied

#### Scenario: Already at checkpoint is a safe no-op

- **WHEN** a pending delivery is reconciled and the supervisor workspace is
  already at the recorded clean checkpoint HEAD
- **THEN** the reconciliation makes no git change and reports the workspace is at
  the checkpoint
