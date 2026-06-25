## ADDED Requirements

### Requirement: Dashboard displays live agent observability events
The dashboard SHALL display durable live agent observability events for active goal runs so users can tell whether work is progressing before the final response is available.

#### Scenario: Running provider emits observations
- **WHEN** a goal detail view is open and the active provider emits observability events
- **THEN** the dashboard appends those events to the timeline through the live event stream without manual refresh

#### Scenario: Observation snapshot is loaded after refresh
- **WHEN** the user refreshes a goal detail view after observability events were emitted
- **THEN** the dashboard loads those events from the durable events snapshot

### Requirement: Dashboard distinguishes observation kinds
The dashboard SHALL render agent observability events with enough semantic distinction for users to identify liveness, progress, command execution, subtask lifecycle, and failures.

#### Scenario: Command observation appears
- **WHEN** the timeline contains a command-started, command-completed, or command-failed observation
- **THEN** the dashboard displays the command state and safe summary without requiring the user to inspect raw stdout

#### Scenario: Heartbeat observation appears
- **WHEN** the timeline contains heartbeat or liveness observations
- **THEN** the dashboard displays them as activity indicators rather than final agent messages

#### Scenario: Subtask observation appears
- **WHEN** the timeline contains a subtask observation with agent or task metadata
- **THEN** the dashboard displays enough context to identify the delegated task or child agent when that metadata is present

### Requirement: Dashboard tolerates partial observation metadata
The dashboard SHALL render observability events even when optional future orchestration metadata is absent.

#### Scenario: Single-agent observation has no parent
- **WHEN** an observability event includes provider/model metadata but no parent agent id or task id
- **THEN** the dashboard renders the event without error

#### Scenario: Unknown observation source appears
- **WHEN** an observability event contains an unknown source or raw provider event type
- **THEN** the dashboard renders the safe message and known metadata without failing the timeline

### Requirement: Dashboard does not expose raw provider output by default
The dashboard SHALL show sanitized observability messages and bounded safe summaries by default rather than raw provider stdout, stderr, or JSONL payloads.

#### Scenario: Observation contains sanitized summary
- **WHEN** an observability event includes a safe summary and provider provenance
- **THEN** the dashboard displays the safe summary
- **AND** it does not display raw credential-bearing fields or raw provider event payloads
