# codex-managed-runtime Specification (Delta)

## ADDED Requirements

### Requirement: Codex adapter surfaces delegation control metadata
The Codex managed runtime adapter SHALL detect fenced control blocks in Codex assistant-message output and attach the parsed control payload as delegation or completion control metadata on the emitted runtime event, instead of emitting the block as plain progress text.

#### Scenario: Assistant message contains a delegation request block
- **WHEN** a Codex `agent_message` item contains a fenced `auto-agent-control` block with type `managed_delegation.request`
- **THEN** the adapter emits a runtime event whose metadata carries the parsed delegation control event
- **AND** the fenced block text does not appear in the event's progress message

#### Scenario: Assistant message contains a completion block
- **WHEN** a Codex `agent_message` item contains a fenced control block with type `managed_delegation.complete`
- **THEN** the adapter emits a runtime event whose metadata carries the parsed completion control event

#### Scenario: Assistant message contains no control block
- **WHEN** a Codex `agent_message` item contains only prose
- **THEN** the adapter emits the same progress observation it emitted before this change

### Requirement: Codex adapter is constructible from saved provider settings
The system SHALL construct the Codex managed runtime adapter from the saved Codex Local provider settings (resolved command path, model label) at goal start, without requiring adapter injection through application options.

#### Scenario: Goal starts with saved Codex Local settings
- **WHEN** a goal starts while Codex Local settings are saved and no adapter is injected
- **THEN** the backend builds the Codex runtime adapter from the resolved command path and model label and starts a managed session

#### Scenario: Managed mode is unavailable
- **WHEN** Codex adapter capability detection reports that managed session execution is unsupported by the installed CLI
- **THEN** the backend records a durable downgrade event and runs the goal through the existing one-shot provider path instead of failing silently
