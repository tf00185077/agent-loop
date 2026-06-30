## ADDED Requirements

### Requirement: Provider item diagnostics are low-noise
The system SHALL avoid surfacing harmless provider item wrappers as alarming user-facing progress when the run remains otherwise healthy.

#### Scenario: Unknown Codex item payload is ignored
- **WHEN** Codex emits `item.started` or `item.completed` with an unknown nested item type
- **THEN** the system does not record a visible `agent.progress` event saying the JSONL event is unrecognized
- **AND** the provider run can still complete through normal final-message and lifecycle behavior

#### Scenario: Malformed Codex JSONL remains visible
- **WHEN** Codex emits malformed JSONL that cannot be parsed
- **THEN** the system records a visible diagnostic progress observation with sanitized bounded text

#### Scenario: Codex failure events remain visible
- **WHEN** Codex emits `error` or `turn.failed`
- **THEN** the system records a visible failure observation and preserves provider failure behavior
