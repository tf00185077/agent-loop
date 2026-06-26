## ADDED Requirements

### Requirement: Delegation metadata on managed sessions
The system SHALL allow managed agent sessions to carry delegation and supervision metadata. Delegation metadata SHALL include supervisor session id, delegating session id, delegation role, task id, safe task summary, and continuation-of session id when available.

#### Scenario: Managed session has supervisor metadata
- **WHEN** a delegated agent session is started by another managed session
- **THEN** the backend persists the delegated session with its supervisor/delegating session metadata
- **AND** the session snapshot includes that metadata without requiring raw provider output

#### Scenario: Continuation session links to prior session
- **WHEN** the backend starts a continuation session after an authority grant
- **THEN** the new managed session records the prior session id as continuation metadata
- **AND** the prior session remains visible in durable history

### Requirement: Authority runtime events
The system SHALL support provider-agnostic runtime events for authority requests, authority grants, authority rejections, and continuation starts. These events SHALL include safe metadata for session id, authority request id, grant id when available, supervisor session id, delegated task id, provider, model, and requested scope when available.

#### Scenario: Runtime requests authority
- **WHEN** a runtime adapter emits an authority-request event
- **THEN** the session manager persists an authority request and marks the session as waiting for authority or waiting for input according to runtime policy

#### Scenario: Runtime authority event is unsupported
- **WHEN** the active runtime cannot support authority requests or continuation
- **THEN** the backend records a sanitized unsupported-control event instead of leaving the session running indefinitely

### Requirement: Authority-aware session controls
The system SHALL route approve, reject, cancel, and continuation controls through the backend session manager. The manager SHALL deliver a control to the active runtime only when the runtime reports support; otherwise it SHALL use the durable restart-as-continuation policy when configured.

#### Scenario: Runtime supports resume
- **WHEN** an authority request is approved for a runtime that supports resume
- **THEN** the session manager records the grant and delivers the control to the active runtime exactly once

#### Scenario: Runtime does not support resume
- **WHEN** an authority request is approved for a runtime that does not support resume
- **THEN** the session manager records the grant and starts or schedules a managed continuation session instead of sending an unsupported resume control
