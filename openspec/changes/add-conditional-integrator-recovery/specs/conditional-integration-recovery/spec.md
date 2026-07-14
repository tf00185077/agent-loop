## ADDED Requirements

### Requirement: Backend conditionally dispatches Integrator after a real conflict
The system SHALL dispatch an `integrator` child immediately and without a Supervisor continuation only when backend delivery observes a conflict applying an accepted candidate, restores the supervisor checkpoint, and has no prior integration attempt for that worker delegation and candidate.

#### Scenario: Conflict starts immediate recovery
- **WHEN** backend cherry-pick of an accepted candidate reports a conflict and checkpoint restoration is verified
- **THEN** the backend persists an integration attempt before dispatching an Integrator child
- **AND** the Supervisor does not need to emit another delegation request

#### Scenario: Conflict-free delivery uses no Integrator
- **WHEN** an accepted candidate applies without conflict
- **THEN** delivery continues through fixed validation and commit without dispatching an Integrator

#### Scenario: Automatic recovery is bounded
- **WHEN** the same worker delegation and original candidate already has an integration attempt
- **THEN** the backend SHALL NOT dispatch another automatic Integrator and SHALL return the durable recovery outcome to the Supervisor

### Requirement: Integration recovery is isolated from the supervisor workspace
The system SHALL reproduce the candidate conflict in a runtime-owned integration worktree rooted at the recorded supervisor checkpoint and SHALL run the Integrator only in that worktree.

#### Scenario: Integrator receives bounded conflict context
- **WHEN** the Integrator child starts
- **THEN** its cwd is the integration worktree and its contract identifies the frozen criteria, checkpoint SHA, original candidate SHA, conflict files, allowed files, and bounded safe diagnostics

#### Scenario: Supervisor workspace remains untouched
- **WHEN** the Integrator runs, fails, times out, or is cancelled
- **THEN** the backend verifies that the supervisor workspace remains at its clean checkpoint before recording the recovery outcome

### Requirement: Integrator uses a strict structured result
The system SHALL accept Integrator completion intent only through one validated `managed_integration.result` that identifies the integration attempt, worker delegation, original candidate, and a safe resolution summary.

#### Scenario: Valid Integrator result is accepted as a claim
- **WHEN** Integrator output contains a well-formed result targeting the active integration attempt and candidate
- **THEN** the backend persists the result and begins authoritative Git verification

#### Scenario: Missing or foreign result fails closed
- **WHEN** Integrator output is missing, malformed, duplicated, or targets a different attempt, worker delegation, or candidate
- **THEN** the backend records resolution failure and does not create a resolved candidate

### Requirement: Backend verifies and creates the resolved candidate
The system SHALL create a resolved candidate only when the integration worktree `HEAD` remains at the checkpoint, contains no unmerged index entries, has a non-empty change, and changes no file outside the original candidate files plus observed conflict files.

#### Scenario: Verified resolution becomes backend candidate
- **WHEN** the structured result is valid and every Git invariant passes
- **THEN** the backend stages only allowed changes, creates the resolved candidate commit, and persists its SHA

#### Scenario: Integrator moves HEAD
- **WHEN** the integration worktree `HEAD` differs from the recorded checkpoint before backend candidate creation
- **THEN** recovery fails closed and the moved commit cannot be delivered

#### Scenario: Conflict remains unresolved
- **WHEN** any unmerged index entry remains after Integrator completion
- **THEN** recovery fails closed and no resolved candidate is created

#### Scenario: Integrator changes an out-of-scope file
- **WHEN** the changed-file set contains a path outside the allowed set
- **THEN** recovery fails closed and records a bounded scope-violation summary

### Requirement: Resolved candidate requires fresh Judge authority
The system SHALL invalidate the original candidate's acceptance for delivery purposes and SHALL require a new Judge decision bound to the exact resolved candidate SHA before applying it to the supervisor workspace.

#### Scenario: Resolved candidate is re-reviewed immediately
- **WHEN** the backend creates a verified resolved candidate
- **THEN** it dispatches a `review_merge` child with the integration attempt, resolved candidate SHA, final diff, frozen criteria, and prior evidence

#### Scenario: Re-review accepts resolved content
- **WHEN** the new Judge decision targets the resolved candidate and marks every frozen criterion `PASS`
- **THEN** backend delivery may apply and validate that resolved candidate

#### Scenario: Re-review rejects or blocks resolved content
- **WHEN** the new Judge decision contains `FAIL` or `BLOCKED`
- **THEN** the backend does not apply the resolved candidate and returns the durable result to the Supervisor

### Requirement: Recovery failure returns durable control
The system SHALL terminate conditional recovery after one Integrator attempt and return a sanitized durable observation to the Supervisor when resolution, re-review, repeated apply, validation, or restart recovery cannot safely complete.

#### Scenario: Resolved candidate conflicts again
- **WHEN** a re-accepted resolved candidate conflicts during final backend apply
- **THEN** the backend restores and verifies the checkpoint, records terminal recovery failure, and does not start another Integrator

#### Scenario: Process restarts during integration
- **WHEN** the backend reopens durable state with a nonterminal integration attempt whose child process cannot be resumed
- **THEN** it records the attempt as interrupted, does not infer success from prose, and returns control without duplicate automatic dispatch
