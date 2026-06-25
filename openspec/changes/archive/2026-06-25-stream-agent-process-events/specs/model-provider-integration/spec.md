## ADDED Requirements

### Requirement: CLI provider output can produce durable progress events
The system SHALL capture safe, meaningful stdout or stderr chunks from local CLI-backed provider processes and persist them as runtime progress events when such chunks are available.

#### Scenario: Provider emits streamable output
- **WHEN** a local CLI-backed provider emits a non-empty progress chunk while a goal run is active
- **THEN** the backend sanitizes the chunk, persists it as a durable event for that goal/run, and makes it available to the live event stream

#### Scenario: Provider emits no streamable output
- **WHEN** a local CLI-backed provider does not expose useful process output before completion
- **THEN** the backend still records normal lifecycle and final result or error events
- **AND** the provider run does not fail solely because no progress chunks were emitted

### Requirement: Process output streaming is credential-safe
The system SHALL sanitize provider process output before storing or streaming it to the dashboard.

#### Scenario: Process output includes credential-like material
- **WHEN** provider process output contains command secret arguments, access tokens, cookies, API keys, authorization headers, or auth cache material
- **THEN** the persisted event and streamed event contain only redacted safe text

### Requirement: Provider final result behavior is preserved
The system SHALL preserve existing provider-backed final response and error semantics while adding live progress events.

#### Scenario: Provider completes after progress chunks
- **WHEN** a provider emits progress chunks and then returns a final response
- **THEN** the timeline contains progress events before the final provider result event
- **AND** the run and goal reach the same terminal state they would have reached without progress streaming
