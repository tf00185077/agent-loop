# multi-epoch-planning Delta

## MODIFIED Requirements

### Requirement: Bounded macro loop
The system SHALL enforce a per-goal planning-epoch budget (configurable base, default 5, plus accepted caller grants forming the effective budget) and a repeated-gap circuit breaker keyed on structured gap identity: the signature of an unsatisfied reassessment SHALL be the sorted, deduplicated union of its gaps' refs, prose summaries SHALL never participate, and an unsatisfied reassessment whose signature equals the previous unsatisfied reassessment's, or one that would exceed the effective epoch budget, SHALL escalate the goal to its caller as a durable input request in `waiting_user` with a durable reason instead of opening another epoch. An accepted caller grant SHALL raise the effective budget so a subsequent unsatisfied reassessment can admit the next epoch under the existing admission gates; the circuit breaker SHALL offer guidance or abandonment but never a budget extension alone.

#### Scenario: Epoch budget exhaustion escalates the goal
- **WHEN** an unsatisfied reassessment arrives and the goal already has its effective maximum number of epochs
- **THEN** the backend records a durable `epoch_budget_exhausted` input request carrying the reassessment's gaps and moves the goal to `waiting_user`

#### Scenario: Repeated gap refs escalate regardless of wording
- **WHEN** two consecutive unsatisfied reassessments carry the same ref-set with differently worded summaries
- **THEN** the backend records a durable `reassessment_circuit_breaker` input request naming the refs and moves the goal to `waiting_user`

#### Scenario: Distinct refs open the next epoch
- **WHEN** consecutive unsatisfied reassessments carry different ref-sets within the effective epoch budget
- **THEN** the next epoch is admitted under the existing admission gate

#### Scenario: Granted epochs admit the next epoch after resume
- **WHEN** a caller grant is accepted after epoch-budget exhaustion and the resumed supervisor emits a valid change plan
- **THEN** the plan opens the next epoch under the existing admission gates using the extended effective budget
