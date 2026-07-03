## ADDED Requirements

### Requirement: Dashboard shows managed delegation tree
The dashboard SHALL show parent-child relationships for managed sessions inside a goal run.

#### Scenario: Child session is active
- **WHEN** a supervisor has an active child session
- **THEN** the dashboard shows the child role, status, parent supervisor relationship, and safe work summary

#### Scenario: Child session completes
- **WHEN** a child completes with success, failure, timeout, cancellation, detached, or ignored status
- **THEN** the dashboard shows the final child outcome in the goal timeline

### Requirement: Dashboard refreshes on delegation events
The dashboard SHALL refresh managed session snapshots when durable delegation state changes.

#### Scenario: Delegation state changes
- **WHEN** the event stream receives a delegation accepted, started, completed, failed, cancelled, timeout, detached, ignored, or continuation-started event
- **THEN** the dashboard refreshes the managed session snapshot and renders the latest delegation tree state
