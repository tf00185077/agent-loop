## ADDED Requirements

### Requirement: Delegation lifecycle states
The runtime control plane SHALL represent supervisor sessions that are waiting for child results and supervisor sessions that are continuing after child results.

#### Scenario: Supervisor waits for child
- **WHEN** the backend accepts a delegation control event
- **THEN** the supervisor run is marked as waiting on the child and emits a durable waiting-child event

#### Scenario: Supervisor continues after child
- **WHEN** a non-detached child result is recorded
- **THEN** the control plane starts or resumes the supervisor continuation and emits a continuation-started event

### Requirement: Tool-shaped delegation control events
The runtime control plane SHALL validate provider output that requests delegation using a strict structured control-event schema.

#### Scenario: Valid delegation event
- **WHEN** provider output contains a valid delegation control event
- **THEN** the backend translates it into a managed spawn request and records the accepted request

#### Scenario: Invalid delegation event
- **WHEN** provider output contains malformed delegation data or unauthorized role/workspace fields
- **THEN** the backend rejects the event, records a validation error, and continues normal provider output handling

### Requirement: Delegation transport remains provider-neutral
The runtime control plane SHALL keep delegation semantics independent from the transport used by a provider.

#### Scenario: Structured output transport is used
- **WHEN** a provider lacks stable tool or MCP support
- **THEN** the backend accepts a validated structured control block as the v1 transport

#### Scenario: Tool transport is added later
- **WHEN** a provider exposes stable tool or MCP calls for delegation
- **THEN** the backend maps the tool call into the same delegation request model used by structured control blocks
