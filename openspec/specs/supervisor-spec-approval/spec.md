# supervisor-spec-approval Specification

## Purpose
TBD - created by archiving change harden-supervisor-delegation-gates. Update Purpose after archive.
## Requirements
### Requirement: Backend-initiated spec review request
After a spec worker result passes structural validation in its worktree, the system SHALL durably record a `change.spec_review_requested` event naming the change and the validated worker delegation request id, SHALL mark that id as the change's sole reviewable attempt, and SHALL append a bounded review packet (proposal, delta specs, tasks; size-capped with an explicit truncation marker; reads confined to the change directory) to the supervisor continuation. The packet SHALL be built from the worker's worktree; when the worktree path is unavailable the system SHALL say so in the packet instead of silently substituting other workspace content.

#### Scenario: Review requested after validation
- **WHEN** a spec worker result passes structural validation
- **THEN** the backend persists `change.spec_review_requested` with the worker delegation request id and delivers the bounded packet in the continuation

#### Scenario: Missing worktree is visible
- **WHEN** the validated worker's worktree path is unavailable at packet-build time
- **THEN** the packet states that the authored artifacts could not be read, and no other workspace's content is presented as the worker's

### Requirement: One durable Supervisor decision per validated attempt
The system SHALL accept a `managed_change.spec_review` control block only when it names the change's current validated attempt and carries a non-empty summary, SHALL persist the decision durably (`change.spec_supervisor_approved` or `change.spec_supervisor_rejected`), and SHALL reject stale, unknown-change, inactive-change, and malformed decisions with durable safe reasons. A repeated decision with the same verdict for the same attempt SHALL be treated as an idempotent duplicate regardless of summary wording; an opposite verdict for an already-decided attempt SHALL be rejected with a safe reason that names the standing decision and the correct next action.

#### Scenario: Decision recorded once
- **WHEN** the supervisor approves the current validated attempt twice with differently worded summaries
- **THEN** exactly one durable approval exists and the second block is accepted as a duplicate without error

#### Scenario: Conflicting verdict is rejected with guidance
- **WHEN** the supervisor rejects an attempt it already approved
- **THEN** the backend rejects the block and the safe reason states the attempt is already approved and that review-merge is the next action

#### Scenario: Stale decision is rejected
- **WHEN** a decision names a worker delegation request id that is not the current validated attempt
- **THEN** the backend rejects it durably, naming the current validated attempt (or "none")

### Requirement: Approval gates spec review-merge
The system SHALL reject a review-merge delegation for a spec task unless the referenced worker attempt is the change's current validated attempt and carries a standing approval. The post-merge completion path SHALL re-check the same gate and SHALL record a durable event when the gate no longer holds; a merged-but-ungated state SHALL never pass silently.

#### Scenario: Unapproved review-merge rejected
- **WHEN** the supervisor requests review-merge for a validated but unapproved spec attempt
- **THEN** the backend rejects the delegation naming the missing approval

#### Scenario: Post-merge gate failure is visible
- **WHEN** the merge completed but the approval gate no longer holds for that attempt
- **THEN** the backend records a durable event naming the change, the attempt, and the gate failure instead of returning silently

### Requirement: New attempts invalidate prior approval
When a new spec worker attempt is dispatched for a change, the system SHALL clear any standing validated-attempt and approval state for that change, SHALL record the invalidation durably (via the attempt-started audit event), and SHALL restore the same state on restart rehydration.

#### Scenario: Approval cleared on corrective dispatch
- **WHEN** a spec attempt is approved and the supervisor dispatches another spec attempt for the same change
- **THEN** the prior approval no longer gates review-merge and the supervisor observation states that the approval was invalidated by the new attempt

#### Scenario: Rehydration preserves review state
- **WHEN** the backend restarts after a review request, a decision, or an invalidating attempt
- **THEN** the rehydrated registry reproduces the same gate outcomes as before the restart

### Requirement: Rejection feedback reaches the corrective attempt
When the Supervisor rejects a validated spec attempt, the system SHALL durably transition the spec task to a re-dispatchable rejected state only when its durable status legally allows that transition — an illegal state SHALL produce a durable rejection event naming the observed status instead of an exception — and SHALL inject the rejection summary verbatim into the next spec worker's prompt appendix.

#### Scenario: Corrective prompt carries exact feedback
- **WHEN** the supervisor rejects with a summary and then dispatches a corrective spec attempt
- **THEN** the corrective worker's prompt contains that summary verbatim

#### Scenario: Illegal durable state fails visibly
- **WHEN** a valid rejection decision arrives while the durable task status does not permit the rejected transition
- **THEN** the backend records a durable rejection of the control block naming the observed status, and the event stream continues

### Requirement: Control-path faults never kill the event pump
The system SHALL catch any error escaping runtime-event persistence for a session, persist a durable error event with a sanitized reason, and fail the run visibly; a control-path fault SHALL NOT terminate the process or leave a goal in `running` with a dead event stream.

#### Scenario: Persistence fault is durable and visible
- **WHEN** handling a control event throws unexpectedly
- **THEN** a durable error event is recorded and the run transitions to a visible failed state

