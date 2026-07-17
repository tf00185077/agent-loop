## MODIFIED Requirements

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

## ADDED Requirements

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
