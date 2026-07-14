## MODIFIED Requirements

### Requirement: Merge outcome validation
The system SHALL derive delivery outcomes from backend-controlled apply, conditional integration recovery, validation, commit, and rollback operations and SHALL persist `committed`, `rejected`, `conflict`, `integration_failed`, `test_failed_reverted`, `revert_failed`, `failed`, or `verification_failed` as typed outcomes.

#### Scenario: Delivery succeeds
- **WHEN** the judge accepts the exact candidate being delivered, the backend applies it, and required validation passes
- **THEN** the backend records `committed` with diff summary, validation evidence, resulting commit SHA, and integration identity when present

#### Scenario: Judge rejects delivery
- **WHEN** the judge decision contains a required criterion that is not `PASS`
- **THEN** the backend records the review outcome without applying the candidate and leaves the supervisor workspace unchanged

#### Scenario: First conflict enters conditional recovery
- **WHEN** backend delivery cannot apply an accepted worker candidate because of conflicts and verified rollback succeeds
- **THEN** it records `conflict`, keeps the task unaccepted, and starts conditional integration recovery when no prior attempt exists

#### Scenario: Recovery cannot safely deliver
- **WHEN** conditional integration fails, the resolved candidate is not re-accepted, or final apply conflicts again
- **THEN** the backend records `integration_failed`, keeps the task unaccepted, verifies the supervisor checkpoint, and returns control to the Supervisor

## ADDED Requirements

### Requirement: Judge decisions authorize an exact candidate
The system SHALL bind every Judge decision used for delivery to the exact reviewed content identity, and a decision for an earlier candidate SHALL NOT authorize a resolved integration candidate.

#### Scenario: Candidate identity matches review
- **WHEN** backend delivery evaluates an accepted Judge decision
- **THEN** the decision's reviewed candidate identity matches the candidate selected for apply

#### Scenario: Candidate changed after acceptance
- **WHEN** integration or any other operation changes the candidate content after Judge acceptance
- **THEN** delivery remains blocked until a fresh valid decision covers the new candidate identity
