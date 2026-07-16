## MODIFIED Requirements

### Requirement: Backend-owned OpenSpec materialization
The system SHALL persist an accepted change plan and its synthetic spec-writing tasks before scaffolding, structurally validating, or archiving OpenSpec change artifacts in the goal workspace through backend-executed operations; agents SHALL NOT be required to run the OpenSpec CLI or load OpenSpec workflow skills. A persistence rejection SHALL occur before any scaffold file or scaffold commit is created, and every later materialization outcome SHALL be recorded durably.

#### Scenario: Scaffolding is materialized and committed
- **WHEN** a change plan and all synthetic tasks are durably accepted in a git-backed goal workspace
- **THEN** the backend materializes the OpenSpec change scaffolding and commits it so child worktrees can see it

#### Scenario: Persistence rejection precedes workspace mutation
- **WHEN** durable registration of an accepted change plan or synthetic task fails
- **THEN** the backend records or propagates the persistence failure
- **AND** it creates no scaffold file and no scaffold commit for that plan

#### Scenario: Materialization failure is durable
- **WHEN** durable plan registration succeeds but OpenSpec scaffolding or its commit fails
- **THEN** the backend records the failed materialization with a safe reason while retaining the accepted durable plan and tasks

#### Scenario: CLI validation gates spec artifacts
- **WHEN** spec artifacts for a change are submitted and the OpenSpec CLI is detected
- **THEN** the backend runs strict validation as an acceptance gate and rejects results whose artifacts do not validate

#### Scenario: Missing CLI degrades visibly
- **WHEN** the OpenSpec CLI cannot be detected
- **THEN** the backend records a durable downgrade event once per goal, renders scaffolding from internal templates, and substitutes internal structural checks and archive moves
