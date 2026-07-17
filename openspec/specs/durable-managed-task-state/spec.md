# durable-managed-task-state Specification

## Purpose
TBD - created by archiving change add-durable-task-completion-gate. Update Purpose after archive.
## Requirements
### Requirement: Managed tasks are first-class durable state
The system SHALL persist each supervisor-announced managed task in SQLite with its Goal, optional change, optional parent task, title, current status, attempt count, substantive rejection count, last cited criteria, last safe summary, and timestamps. A child-bearing task list SHALL persist its validated parent `split` transition, complete frozen child set, criteria, and sanitized audit evidence in one transaction before any in-memory task or change registry acknowledges the list.

#### Scenario: Task list creates durable tasks
- **WHEN** the backend accepts a supervisor task-list control block
- **THEN** it persists each task and its lineage before acknowledging the task list
- **AND** the same task state remains queryable after the database is reopened

#### Scenario: Task transition updates state and audit together
- **WHEN** a managed task changes status or counters
- **THEN** the backend updates its durable state and appends the corresponding sanitized event atomically

#### Scenario: Split registration fails transactionally
- **WHEN** a database error or validator rejection occurs while registering a proposed child set
- **THEN** SQLite contains neither a partial child set nor a parent split transition or split audit event
- **AND** the in-memory task and change registries retain their pre-request state

#### Scenario: Durable commit precedes cache refresh
- **WHEN** a valid split registration commits but the process stops before the in-memory registry refresh completes
- **THEN** restart rehydrates the parent as `split` and every committed child from SQLite
- **AND** no duplicate child or split transition is created

#### Scenario: Cache refresh throws after durable registration
- **WHEN** task registration commits and the immediate in-memory cache refresh fails
- **THEN** the backend records a visible cache-refresh interruption, leaves the Goal `interrupted`, and stops the session for restart rehydration
- **AND** it does not report the already-committed task list as a zero-write control rejection

### Requirement: Worker delegations are durable task attempts
The system SHALL associate every contracted worker delegation with a monotonically increasing attempt number for its task and SHALL preserve the attempt lifecycle, child session, structured result, attested files, tests, and safe summary.

#### Scenario: Retry creates a new attempt
- **WHEN** a worker is delegated a task that has a prior attempt
- **THEN** the new delegation receives the next attempt number without overwriting prior attempt evidence

#### Scenario: Restart preserves retry bounds
- **WHEN** the backend restarts after one or more attempts or substantive rejections
- **THEN** the next delegation gate uses the persisted counts and enforces the same retry or narrowing decision as before restart

### Requirement: Criterion definitions and outcomes are durable and distinct
The system SHALL persist immutable criterion id/text definitions separately from attempt-scoped evidence and authoritative outcomes, and each required criterion outcome SHALL be one of `UNKNOWN`, `PASS`, `FAIL`, or `BLOCKED`.

#### Scenario: Executor evidence remains a claim
- **WHEN** a worker reports evidence for a criterion
- **THEN** the backend stores the claim on that attempt without changing the authoritative criterion outcome to `PASS`

#### Scenario: Judge decision updates authoritative outcome
- **WHEN** a valid judge decision covers a frozen criterion
- **THEN** the backend persists the attempt-scoped decision and updates the task criterion's current authoritative outcome

### Requirement: Review and delivery decisions are durable
The system SHALL persist structured Judge verdicts, conditional integration attempts, and backend delivery outcomes as first-class records linked to the worker attempt and exact candidate identity they concern.

#### Scenario: Accepted review is persisted
- **WHEN** the Judge accepts every criterion for a worker or resolved integration candidate
- **THEN** the backend stores the Judge identity, reviewed candidate SHA when available, integration attempt when present, overall verdict, per-criterion decisions, cited criteria, and safe summary

#### Scenario: Integration attempt is persisted
- **WHEN** backend delivery enters conditional conflict recovery
- **THEN** it stores the task and delegation identities, lifecycle status, checkpoint SHA, original and resolved candidate SHAs when present, conflict and allowed files, bounded summaries, and timestamps before acknowledging each transition

#### Scenario: Delivery outcome is persisted
- **WHEN** the backend applies, validates, commits, rejects, integrates, or rolls back a reviewed attempt
- **THEN** it stores the delivery status, checkpoint, candidate and integration identities, validation evidence, resulting commit SHA when present, and rollback evidence when required

### Requirement: Durable integration state fails closed across restart
The system SHALL project integration attempts and candidate-bound re-review state from SQLite and SHALL NOT duplicate automatic recovery or infer acceptance after restart.

#### Scenario: Restart after resolved candidate creation
- **WHEN** the database reopens after a resolved candidate was persisted but before a valid candidate-bound re-review completed
- **THEN** durable context reports pending re-review and the resolved candidate cannot satisfy delivery

#### Scenario: Restart loses active Integrator process
- **WHEN** a nonterminal Integrator child cannot be truly resumed after restart
- **THEN** the backend records an interrupted terminal outcome, preserves the one-attempt bound, and returns the gap to the Supervisor

### Requirement: Runtime context is projected from durable state
The system SHALL build supervisor continuation context from durable goal, change, task, attempt, criterion, review, and delivery state plus bounded sanitized summaries; raw AI response history SHALL NOT be the authoritative source of current runtime state.

#### Scenario: Continuation after restart uses durable projection
- **WHEN** a continuation is built after reopening the database
- **THEN** it contains the same task statuses, attempt counts, criterion gaps, last judge decision, and delivery state recorded before restart

#### Scenario: Historical prose conflicts with current state
- **WHEN** an earlier AI response claims completion but durable criterion or delivery state remains incomplete
- **THEN** the context identifies the durable gaps and does not present the prose claim as current fact

### Requirement: Historical state backfill fails closed
The system SHALL preserve historical terminal goals and SHALL mark any unprovable criterion outcome for a migrated non-terminal goal as `UNKNOWN` rather than inferring success from plain summaries.

#### Scenario: Legacy success has no criterion decision
- **WHEN** a non-terminal historical delegation has a success summary but no authoritative criterion decision
- **THEN** migration preserves the summary and records the affected criterion outcomes as `UNKNOWN`
- **AND** completion remains blocked until authoritative decisions exist

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

### Requirement: Managed task lineage has one durable fail-closed projection
The system SHALL derive Goal-scoped task lineage from durable rows through one recursive evaluator shared by change archival and Goal completion. The evaluator SHALL classify leaves and valid split parents consistently and SHALL return a structured `invalid_split_lineage` gap for status/descendant disagreement, a missing or cyclic edge, cross-Goal or cross-change ownership, or a descendant set inconsistent with frozen split evidence.

#### Scenario: Non-split parent has a child
- **WHEN** durable rows contain a parent with one or more descendants but the parent is not `split`
- **THEN** the shared evaluator returns `invalid_split_lineage` identifying the bounded logical task IDs and stable reason
- **AND** neither change archival nor Goal completion treats that graph as satisfied

#### Scenario: Split parent has no child
- **WHEN** a durable task is `split` but has no persisted descendant
- **THEN** the shared evaluator returns `invalid_split_lineage` and both gates fail closed

#### Scenario: Valid recursive split resolves through leaves
- **WHEN** every non-leaf is durably `split`, every split has a valid frozen descendant set, and every required leaf is accepted
- **THEN** archive and completion receive the same satisfied leaf closure for that lineage

#### Scenario: Frozen split evidence disagrees with descendants
- **WHEN** durable descendants differ from the child IDs frozen by `managed_task.lineage_split` or a conclusive migration record
- **THEN** the shared evaluator returns `invalid_split_lineage` with reason `frozen_child_set_mismatch`
- **AND** archive and completion both fail closed on that same durable graph

#### Scenario: Cache disagrees with SQLite
- **WHEN** an in-memory task status or edge differs from the durable lineage projection
- **THEN** archive and completion use the SQLite projection and the cache is rehydrated rather than used as authority

#### Scenario: Frozen acceptance contract migration remains ambiguous
- **WHEN** the frozen-contract migration names an otherwise accepted task whose criteria currently pass as ambiguous historical data
- **THEN** the shared durable projection returns `invalid_split_lineage` with reason `ambiguous_frozen_contract`
- **AND** completion and change archive both fail closed on that task instead of trusting the guessed contract

### Requirement: Historical split-lineage repair fails closed
The system SHALL run split-lineage backfill only through the named, transactional, re-entrant migration `managed-task-split-lineage-repair-v1`. It SHALL repair a historical parent to `split` only when durable chronology proves the retry threshold preceded child registration, ownership and deterministic narrowing are valid, the descendant set is unambiguous, and no parent pipeline operation is active or pending. Frozen-contract migration markers SHALL keep bounded human diagnostics separate from a complete enforcement identity consumed by completion, archive, and recovery. It SHALL preserve raw audit history and all terminal Goal lifecycle state.

#### Scenario: Incident-shaped lineage is provably repaired
- **WHEN** a historical parent reached the retry threshold before a same-Goal, same-change, strictly narrower child set was registered and no parent work remains active or pending
- **THEN** the migration transitions only that parent projection to `split`, records bounded migration evidence, and leaves its child and audit records intact
- **AND** every child frozen by that evidence was created no later than the evidence timestamp

#### Scenario: One frozen child postdates split evidence
- **WHEN** split evidence names multiple children but any named child was created after that evidence
- **THEN** the migration records `ambiguous_chronology`, leaves the parent unchanged, and does not freeze or bless that descendant set

#### Scenario: Historical lineage is ambiguous
- **WHEN** threshold chronology, ownership, narrowing, descendant membership, or quiescent parent state cannot be proven
- **THEN** the migration leaves every affected task row unchanged, records bounded task IDs and reason codes in migration diagnostics, and completion remains fail closed

#### Scenario: Frozen-contract ambiguity exceeds the diagnostic bound
- **WHEN** more than 50 frozen-contract ambiguities are found and an affected accepted/PASS task is omitted from the bounded human diagnostic array
- **THEN** the migration persists that task in the complete enforcement identity and completion, its owning change archive, and operator recovery all fail closed
- **AND** a Goal absent from the complete enforcement identity remains unaffected

#### Scenario: Legacy truncated frozen-contract marker has no complete identity
- **WHEN** an already-written v1 marker declares more ambiguities than its bounded task array contains and has no complete enforcement representation
- **THEN** completion, change archive, and operator recovery treat the marker as globally ambiguous rather than guessing the omitted Goal/task owners

#### Scenario: Present frozen-contract marker has invalid details
- **WHEN** the frozen-contract marker row exists but `details` is malformed JSON or valid JSON that is not an object
- **THEN** completion, change archive, and operator recovery fail closed globally with `ambiguous_frozen_contract`
- **AND** marker absence, valid fresh baseline, valid zero ambiguity, task-scoped v1, complete enforcement identity, and legacy truncated-global semantics remain distinct and unchanged

#### Scenario: Existing blocked Goal remains terminal
- **WHEN** the migration repairs provable subordinate lineage for a Goal already in `blocked` state
- **THEN** it does not change Goal status, terminal timestamps, runs, sessions, events, continuation history, or start provider work

#### Scenario: Migration reopens safely
- **WHEN** a database is reopened after the split-lineage migration committed
- **THEN** the migration makes no additional task, Goal, session, event, or archive mutation
- **AND** a simulated failure before its marker commits rolls back the repair and marker together
