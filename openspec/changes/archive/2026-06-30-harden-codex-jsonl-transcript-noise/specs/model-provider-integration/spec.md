## ADDED Requirements

### Requirement: Codex JSONL item payloads are parsed semantically
The system SHALL parse current Codex JSONL `item` payloads into existing provider observations without requiring users to infer command or message state from raw JSONL text.

#### Scenario: Command execution item starts
- **WHEN** Codex emits `item.started` with an item type of `command_execution`
- **THEN** the system records an `agent.command.started` observation with a safe command label when one is available

#### Scenario: Command execution item completes
- **WHEN** Codex emits `item.completed` with an item type of `command_execution`
- **THEN** the system records an `agent.command.completed` observation with completion status, exit code when available, and bounded safe output summaries when available

#### Scenario: Command execution item fails
- **WHEN** Codex emits `item.failed` with an item type of `command_execution`
- **THEN** the system records an `agent.command.failed` observation with a safe failure summary and command metadata when available

#### Scenario: Agent message item completes
- **WHEN** Codex emits `item.completed` with an item type of `agent_message` and assistant text
- **THEN** the system records provider progress containing that text
- **AND** the system treats that text as a candidate final provider message

#### Scenario: Legacy command item remains supported
- **WHEN** Codex emits `item.started`, `item.completed`, or `item.failed` with the legacy item type of `command`
- **THEN** the system records the same command lifecycle observation it recorded before this change
