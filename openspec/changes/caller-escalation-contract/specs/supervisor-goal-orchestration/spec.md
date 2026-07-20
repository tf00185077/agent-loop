# supervisor-goal-orchestration Delta

## MODIFIED Requirements

### Requirement: Iterate until explicit completion
The system SHALL continue a managed supervisor across multiple delegation cycles until the supervisor emits an explicit completion signal or a terminal failure, cancellation, or configured bound is reached; provider process exit alone SHALL NOT complete the goal. The continuation bound SHALL be the goal's effective continuation bound (configured base plus accepted caller grants), and reaching it SHALL escalate to the goal's caller as a durable input request instead of terminally blocking the goal.

#### Scenario: Multi-task goal runs task by task
- **WHEN** a supervisor decomposes a goal into multiple tasks and delegates them sequentially
- **THEN** each worker result returns to the supervisor as an observation and the supervisor continues to the next delegation without user input

#### Scenario: Session exits without completion signal
- **WHEN** a supervisor session ends without a completion signal and without a pending delegation
- **THEN** the backend starts a supervisor continuation prompting the supervisor to continue or complete, and records a durable continuation event

#### Scenario: Continuation bound reached
- **WHEN** the number of completion-less supervisor continuations reaches the goal's effective continuation bound
- **THEN** the backend records a durable `continuation_exhausted` input request and moves the goal to `waiting_user` instead of continuing or terminally blocking

#### Scenario: Granted continuations extend the bound
- **WHEN** a caller's accepted response grants additional continuations and the goal resumes
- **THEN** subsequent continuation checks use the extended effective bound and the continuation history reflects the pre-escalation cycles
