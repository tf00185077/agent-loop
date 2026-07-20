# supervisor-goal-orchestration Delta

## ADDED Requirements

### Requirement: Supervisor caller-input requests
The system SHALL accept a `managed_goal.request_input` control block from a managed
goal's supervisor only when deterministic gates pass: the block carries a non-empty
question within the configured length bound and at most the configured number of
bounded context strings; the goal has no pending input request; the emitting session
has no in-flight child delegation; and the goal has not exhausted its per-goal
question budget (configurable, default 3, counted from durable question requests of
any status). Every rejection SHALL be durable and carry a safe reason that teaches
the correct next action, including instructing an over-budget supervisor to decide
autonomously and proceed. Prompt text SHALL only inform; these gates are backend
enforcement.

#### Scenario: Valid question parks the goal
- **WHEN** a supervisor with no in-flight delegation and remaining question budget emits a well-formed question block
- **THEN** the backend records the request durably, the goal moves to `waiting_user`, and the ending session starts no continuation

#### Scenario: Question during an in-flight delegation is rejected
- **WHEN** a supervisor emits a question block while a child delegation is requested, accepted, or running
- **THEN** the backend rejects it with a durable safe reason telling the supervisor to wait for the child observation first, and goal state is unchanged

#### Scenario: Question budget exhaustion teaches autonomy
- **WHEN** a supervisor emits a question block after the goal's question budget is exhausted
- **THEN** the backend rejects it with a durable safe reason instructing the supervisor to decide autonomously using its best judgment, and the loop continues

#### Scenario: Malformed question is rejected
- **WHEN** a question block has an empty or oversized question or oversized context strings
- **THEN** the backend rejects it with a durable safe reason naming the bounds
