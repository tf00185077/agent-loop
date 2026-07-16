## MODIFIED Requirements

### Requirement: Durable rejection lineage per task
The system SHALL persist, per task, the count of substantive rejections, the criterion identifiers cited by each rejection, and the lineage between a task and any narrower tasks it was split into. Registering the first child set through `parentTaskId` SHALL be one atomic narrowing transition that validates every child before changing state, transitions the eligible parent to `split`, freezes the complete descendant set, inserts the children and criteria, and records sanitized audit evidence together. The transition SHALL fail closed without any durable or in-memory mutation when the parent or any child is ineligible.

#### Scenario: Substantive rejection is recorded on the lineage
- **WHEN** a task result receives a substantive rejection citing criterion identifiers
- **THEN** durable events record the incremented rejection count and the cited criteria for that task

#### Scenario: Eligible child set establishes the split
- **WHEN** a task at the retry threshold has no active attempt, pending review, pending delivery, or nonterminal integration and one task list supplies one or more new children in the same Goal and change with non-empty contracts strictly smaller than the parent's contract
- **THEN** the backend atomically transitions the parent to `split`, persists every child with `parentTaskId`, freezes the child set, and records the split audit evidence

#### Scenario: One invalid sibling rolls back the split
- **WHEN** any child in a proposed child set has a duplicate identifier, wrong Goal or change, empty or non-narrower contract, cycle, or otherwise invalid lineage
- **THEN** the backend persists none of the children and does not transition the parent or mutate the in-memory task registry

#### Scenario: Split child set is idempotent and frozen
- **WHEN** the Supervisor re-announces the exact already-persisted child set and contracts for a `split` parent
- **THEN** the backend treats the announcement as an idempotent no-op
- **AND** an attempt to add, remove, or replace a descendant after the split is frozen is rejected without changing lineage

#### Scenario: Ineligible parent cannot acquire children
- **WHEN** `parentTaskId` names a parent below the retry threshold, an accepted parent, a parent with active or pending pipeline state, or a parent owned by a different Goal or change
- **THEN** the complete task-list registration is rejected with a sanitized reason and no lineage edge is persisted
