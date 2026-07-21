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
`supervisor_question`, `plan_confirmation`}, a sanitized summary, and a structured
payload. For macro-loop reasons the payload carries the latest reassessment's evidence
and structured remaining gaps; for bound reasons the exhausted bound's name and current
effective value; for the conversation-type reasons (`supervisor_question`,
`plan_confirmation`) the supervisor-supplied context and the durable message thread with
null budget fields. The allowed caller decisions per reason are: `extend_budget`,
`provide_guidance`, `abandon` for budget reasons; `provide_guidance`, `abandon` for the
circuit breaker; and `provide_guidance`, `proceed`, `abandon` for the conversation-type
reasons.

#### Scenario: Budget exhaustion request carries gaps and allowed decisions
- **WHEN** an `epoch_budget_exhausted` input request is recorded
- **THEN** its payload includes the remaining gaps and evidence from the latest reassessment, the budget name and effective value, and allowed decisions `extend_budget`, `provide_guidance`, `abandon`

#### Scenario: Circuit breaker request excludes budget extension
- **WHEN** a `reassessment_circuit_breaker` input request is recorded
- **THEN** its allowed decisions are exactly `provide_guidance` and `abandon`

#### Scenario: Conversation requests carry a thread and proceed
- **WHEN** a `supervisor_question` or `plan_confirmation` input request is recorded
- **THEN** its payload budget fields are null, it carries a durable message thread, and its allowed decisions are `provide_guidance`, `proceed`, `abandon`

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

### Requirement: Input requests carry a durable message thread
The system SHALL persist a conversation-type input request (`supervisor_question`,
`plan_confirmation`) with a durable ordered thread of messages, each
`{ role: "supervisor" | "caller", text, at }`, and a phase of `awaiting_caller`,
`awaiting_supervisor`, or `resolved`. The opening supervisor message SHALL be thread
entry zero with phase `awaiting_caller`. The thread and phase SHALL be reconstructable
from durable state alone after a restart.

#### Scenario: A question opens a thread awaiting the caller
- **WHEN** a supervisor question or plan proposal is recorded
- **THEN** the input request holds a one-entry supervisor thread with phase `awaiting_caller`

#### Scenario: Thread survives restart
- **WHEN** the backend restarts while a conversation is open
- **THEN** the thread and phase are unchanged and the caller can still reply from durable state

### Requirement: Caller replies run a read-only conversational turn
The system SHALL, for a conversation-type request whose phase is `awaiting_caller`,
treat an accepted `provide_guidance` reply as a thread message rather than a working
resume: it SHALL append the caller message, flip the phase to `awaiting_supervisor`, and
run the supervisor as a read-only conversational turn (fresh session rehydrated from
durable state). During that turn the backend SHALL honor only the whitelisted control
blocks `managed_goal.request_input`, `managed_goal.propose_plan`, and
`managed_goal.ready_to_proceed`, and SHALL reject every other control block with a
durable safe reason stating the turn is read-only. The turn SHALL NOT delegate, plan,
run acceptance work, or complete the goal.

#### Scenario: A work block during a conversational turn is rejected
- **WHEN** the supervisor emits a delegation, task-list, change-plan, or completion block during a conversational turn
- **THEN** the backend rejects it with a durable read-only safe reason and the goal stays in the conversation

#### Scenario: The supervisor continues the conversation
- **WHEN** a conversational turn emits another `managed_goal.request_input` or `managed_goal.propose_plan`
- **THEN** the backend appends the supervisor message, sets phase `awaiting_caller`, and the goal stays `waiting_user`

### Requirement: The supervisor closes a conversation with ready_to_proceed
The system SHALL, when a conversational turn emits `managed_goal.ready_to_proceed`,
resolve the request (`phase = resolved`), close the conversation, and resume a fresh
working session whose continuation observation carries the whole thread. A conversation
opened by a `plan_confirmation` request that closes this way SHALL record a standing
caller confirmation for the goal's current epoch.

#### Scenario: Ready resumes the working loop with the thread
- **WHEN** a conversational turn emits `ready_to_proceed`
- **THEN** the request resolves, the goal returns to `running`, and the fresh supervisor prompt contains the conversation thread

#### Scenario: Plan confirmation records a standing confirmation
- **WHEN** a `plan_confirmation` conversation closes with `ready_to_proceed`
- **THEN** a standing confirmation is recorded for the current epoch

### Requirement: The caller can force-proceed or abandon a conversation
The system SHALL accept a `proceed` caller decision on a conversation-type request that
force-closes the conversation and resumes the working loop even if the supervisor has
not signalled ready, recording a caller-forced standing confirmation for a
`plan_confirmation` conversation. An `abandon` decision SHALL block the goal terminally
as for other escalations.

#### Scenario: Caller force-proceeds
- **WHEN** the caller answers a conversation with `proceed`
- **THEN** the conversation resolves, the goal resumes running, and a plan-confirmation conversation records a caller-forced standing confirmation

#### Scenario: Caller abandons a conversation
- **WHEN** the caller answers a conversation with `abandon`
- **THEN** the goal transitions to terminal `blocked` with a caller-attributed reason

### Requirement: Conversations are bounded by a turn budget
The system SHALL bound the number of supervisor conversational turns per goal
(configurable). When the budget is exhausted the system SHALL resolve the open
conversation with a durable safe reason instructing the supervisor to proceed on its
best understanding, and — under a `required` confirmation policy — SHALL record a forced
standing confirmation so the goal is not deadlocked.

#### Scenario: Turn budget exhaustion resolves the conversation
- **WHEN** supervisor conversational turns reach the configured budget
- **THEN** the conversation resolves with an autonomy safe reason and the working loop resumes
