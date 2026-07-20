# caller-escalation Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
