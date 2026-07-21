# caller-escalation Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
