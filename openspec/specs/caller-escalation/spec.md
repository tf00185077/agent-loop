# caller-escalation Specification

## Purpose

Define the goal-level escalation contract: when a recoverable budget bound would
terminate a goal, the backend instead asks the goal's caller — human or agent — a
structured question, waits durably in `waiting_user`, validates the caller's response
deterministically, and resumes the supervisor loop or blocks terminally per the
decision.

## Requirements

### Requirement: Recoverable goal-level blocks escalate instead of terminating
The system SHALL, for the recoverable goal-level bound decisions (epoch-budget
exhaustion, reassessment circuit breaker, supervisor-continuation exhaustion), record a
durable goal input request and transition the goal to the non-terminal `waiting_user`
status instead of writing terminal `blocked`, closing out the live supervisor session.
A goal SHALL have at most one pending input request at a time. Unrecoverable block
decisions (archive capability unavailable, lineage-recovery blockers) SHALL continue to
write terminal `blocked`.

#### Scenario: Epoch budget exhaustion escalates
- **WHEN** an unsatisfied reassessment would exceed the goal's effective epoch budget
- **THEN** the backend records a durable input request with reason `epoch_budget_exhausted`, sets the goal to `waiting_user`, and closes the supervisor session without starting provider work

#### Scenario: Continuation exhaustion escalates
- **WHEN** completion-less supervisor continuations reach the goal's effective continuation bound
- **THEN** the backend records a durable input request with reason `continuation_exhausted` and sets the goal to `waiting_user`

#### Scenario: Unrecoverable blockers stay terminal
- **WHEN** archive capability is unavailable during resume reconciliation or a lineage-recovery blocker fires
- **THEN** the goal transitions to terminal `blocked` exactly as before and no input request is created

### Requirement: Input requests are structured and machine-readable
The system SHALL persist each input request with a reason code from the closed set
{`epoch_budget_exhausted`, `reassessment_circuit_breaker`, `continuation_exhausted`,
`supervisor_question`}, a sanitized summary, a structured payload carrying the
evidence available at the block site (for macro-loop reasons: the latest
reassessment's evidence and structured remaining gaps; for bound reasons: the
exhausted bound's name and current effective value; for supervisor questions: the
supervisor-supplied context strings, with null budget fields), and the closed set of
allowed decisions for that reason code: `extend_budget`, `provide_guidance`, and
`abandon` for budget reasons; `provide_guidance` and `abandon` for the circuit
breaker and for supervisor questions.

#### Scenario: Budget exhaustion request carries gaps and allowed decisions
- **WHEN** an `epoch_budget_exhausted` input request is recorded
- **THEN** its payload includes the remaining gaps and evidence from the latest reassessment, the budget name and effective value, and allowed decisions `extend_budget`, `provide_guidance`, `abandon`

#### Scenario: Circuit breaker request excludes budget extension
- **WHEN** a `reassessment_circuit_breaker` input request is recorded
- **THEN** its allowed decisions are exactly `provide_guidance` and `abandon`

#### Scenario: Question request carries null budget fields
- **WHEN** a `supervisor_question` input request is recorded
- **THEN** its payload budget name and value are null, its allowed decisions are exactly `provide_guidance` and `abandon`, and its summary is the sanitized question

### Requirement: Caller responses are validated deterministically
The system SHALL accept a response to a pending input request only when its decision is
in the request's allowed decisions and its fields are well-formed: `extend_budget`
SHALL carry an integer extension between 1 and the configured base budget for the
exhausted bound; `provide_guidance` SHALL carry a non-empty bounded guidance string;
`abandon` MAY carry an optional reason. Invalid responses SHALL be rejected with a safe
reason naming the allowed decisions and leave the request pending and goal state
unchanged. A response to a request that is not pending SHALL be rejected by naming the
standing resolution without changing state.

#### Scenario: Disallowed decision is rejected
- **WHEN** a caller answers a circuit-breaker request with `extend_budget`
- **THEN** the backend rejects the response naming the allowed decisions and the request remains pending

#### Scenario: Out-of-range extension is rejected
- **WHEN** a caller answers with `extend_budget` and an extension of 0 or above the configured base budget
- **THEN** the backend rejects the response with a safe reason and the request remains pending

#### Scenario: Second response meets the standing resolution
- **WHEN** a caller responds to a request that was already accepted
- **THEN** the backend rejects the late response naming the standing resolution and performs no side effect

### Requirement: Effective budgets derive from accepted grants
The system SHALL compute a goal's effective epoch budget and effective continuation
bound as the configured base plus the sum of accepted `extend_budget` grants for that
goal, SHALL use the effective values in the corresponding bound checks, and SHALL
recompute them from durable records on restart. An accepted `provide_guidance`
response SHALL implicitly grant the minimal extension (1) only for the
budget-exhaustion reasons (`epoch_budget_exhausted`, `continuation_exhausted`);
guidance accepted for the circuit breaker or for a supervisor question SHALL grant
nothing.

#### Scenario: Granted epochs admit the next epoch
- **WHEN** a caller's `extend_budget` response granting 2 epochs is accepted after epoch-budget exhaustion
- **THEN** the next unsatisfied-reassessment check uses base + 2 and the next epoch is admitted under the existing admission gates

#### Scenario: Grants survive restart
- **WHEN** the backend restarts after an accepted grant
- **THEN** the rehydrated bound checks use the same effective values recomputed from durable records

#### Scenario: Answering a question grants no budget
- **WHEN** a caller's `provide_guidance` answer to a `supervisor_question` request is accepted
- **THEN** the goal's effective budgets are unchanged

### Requirement: Accepted responses resume or terminally block the goal
The system SHALL, on an accepted `extend_budget` or `provide_guidance` response, mark
the request accepted, record a durable response event, and resume the goal as a fresh
supervisor continuation: registries rehydrated from durable state, the continuation
prompt carrying a deterministic rendering of the caller's decision (granted extension
and/or guidance text) as an observation, and the goal returned to `running`. On an
accepted `abandon` response the goal SHALL transition to terminal `blocked` with a
durable reason attributing the decision to the caller.

#### Scenario: Guidance is injected into the resumed supervisor
- **WHEN** a `provide_guidance` response is accepted
- **THEN** a fresh supervisor continuation starts whose prompt includes the caller's guidance as an observation alongside the rehydrated task and change history, and the goal returns to `running`

#### Scenario: Abandon blocks the goal
- **WHEN** an `abandon` response is accepted
- **THEN** the goal transitions to terminal `blocked` with a durable caller-abandoned reason and no provider work starts

### Requirement: Waiting goals are stable across restart and cancellation
The system SHALL treat `waiting_user` as a stable non-terminal state: startup
reconciliation SHALL NOT sweep a `waiting_user` goal into interrupted recovery, its
worktrees SHALL NOT be reclaimed, and its pending input request SHALL remain answerable
from durable state alone after restart. Cancelling a `waiting_user` goal SHALL resolve
the pending request as cancelled and follow the existing cancellation flow.

#### Scenario: Waiting goal survives restart
- **WHEN** the backend restarts while a goal is `waiting_user`
- **THEN** the goal remains `waiting_user` with its worktrees intact and a caller response after restart is validated and applied normally

#### Scenario: Cancel resolves the pending request
- **WHEN** a `waiting_user` goal is cancelled
- **THEN** the pending input request resolves as cancelled and the goal follows the existing cancellation flow

### Requirement: Caller-facing escalation API
The system SHALL expose the pending input request of a goal (including reason code,
payload, and allowed decisions) through a goal-scoped read endpoint, and SHALL accept
responses through a goal-scoped respond endpoint, both consuming and producing only
sanitized, machine-readable JSON so that human dashboards and agent callers use the
same contract.

#### Scenario: Caller reads the pending request
- **WHEN** a caller requests the pending input request of a `waiting_user` goal
- **THEN** the API returns the structured request; when no request is pending it returns a not-found result

#### Scenario: Dashboard and API callers share one contract
- **WHEN** any client responds through the respond endpoint
- **THEN** validation and side effects are identical regardless of client

### Requirement: Escalation transitions are durably observable
The system SHALL record durable events for every escalation transition — request
created, response accepted, response rejected, goal resumed, goal abandoned — writing
the event before dependent state changes stream, so the event timeline alone tells the
escalation story.

#### Scenario: Timeline tells the escalation story
- **WHEN** a goal escalates, receives an accepted extension, and resumes
- **THEN** the goal's event timeline contains the request-created, response-accepted, and continuation-started events in order with sanitized data

### Requirement: Supervisor questions reuse the escalation contract
The system SHALL record an accepted `managed_goal.request_input` control block as a
`supervisor_question` input request whose sanitized summary is the question text and
whose payload evidence is the supervisor-supplied context, move the goal to
`waiting_user`, and serve and resolve it through the same durable ledger, API
endpoints, and validation as backend-initiated requests. When a `provide_guidance`
response to a question is accepted, the resume observation SHALL carry both the
question and the caller's answer.

#### Scenario: Question waits under the shared contract
- **WHEN** a supervisor's question block is accepted
- **THEN** the goal is `waiting_user` with a pending `supervisor_question` request readable via the existing input-request endpoint, offering exactly `provide_guidance` and `abandon`

#### Scenario: Answer resumes with question and answer in context
- **WHEN** a caller's `provide_guidance` answer to a question is accepted
- **THEN** a fresh supervisor continuation starts whose observation contains the original question and the answer, and the goal returns to `running`

#### Scenario: Abandoning a question blocks the goal
- **WHEN** a caller answers a question request with `abandon`
- **THEN** the goal transitions to terminal `blocked` with a caller-attributed durable reason, exactly as for other escalations
