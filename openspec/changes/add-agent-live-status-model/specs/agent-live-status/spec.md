## ADDED Requirements

### Requirement: Live status is projected from durable authority
The system SHALL project a goal's compact current activity from durable goal,
session, approval, delegation, managed-task, review/delivery, and integration
state. Sanitized events MAY supplement missing summary and activity time but
SHALL NOT override structured current state.

#### Scenario: Status is reconstructed after refresh
- **WHEN** the dashboard reloads or the database is reopened
- **THEN** the backend derives the same current state and phase from durable records
- **AND** no active provider process, SSE connection, or browser reducer is required

#### Scenario: Historical prose conflicts with structured state
- **WHEN** a prior event claims completion but a managed task is awaiting delivery
- **THEN** live status reports the delivery phase rather than completed

### Requirement: Live status separates state from pipeline phase
The system SHALL expose a coarse `state` and a role-aware `phase` so users can
distinguish outcome/waiting semantics from the active pipeline component.

#### Scenario: Worker is active
- **WHEN** the authoritative active delegation role is `worker`
- **THEN** live status reports `waiting` with phase `worker`
- **AND** includes the task and delegation identities when available

#### Scenario: Original Judge is active
- **WHEN** `review_merge` is reviewing a Worker candidate without an awaiting integration re-review
- **THEN** live status reports `waiting` with phase `judge`

#### Scenario: Integrator resolves a conflict
- **WHEN** durable integration state is `pending` or `resolving`
- **THEN** live status reports `waiting` with phase `integrator`
- **AND** includes the integration attempt identity

#### Scenario: Resolved candidate awaits re-Judge
- **WHEN** durable integration state is `awaiting_review`
- **THEN** live status reports `waiting` with phase `rejudge`
- **AND** includes the resolved candidate identity when present

#### Scenario: Backend delivery remains pending
- **WHEN** a managed task or accepted integration is awaiting backend delivery
- **THEN** live status reports `running` with phase `delivery`

### Requirement: Terminal and human-waiting states have precedence
The system SHALL apply deterministic precedence so terminal goal and explicit
human-waiting states cannot be hidden by stale lower-level activity.

#### Scenario: Terminal goal has stale active session
- **WHEN** a goal is completed, failed, blocked, or cancelled while an older session record is nonterminal
- **THEN** live status reports the goal's terminal state with phase `none`

#### Scenario: Approval is pending
- **WHEN** the current session has a pending approval
- **THEN** live status reports `waiting` with phase `approval` and a sanitized approval summary

#### Scenario: Session is stalled
- **WHEN** no higher-precedence state applies and the current session is stalled
- **THEN** live status reports `stalled` with the best known pipeline phase

#### Scenario: Integration is interrupted
- **WHEN** a nonterminal recovery is durably marked `interrupted` after restart
- **THEN** live status reports `stalled` with phase `integrator`
- **AND** does not infer success from prior Integrator prose

### Requirement: Live status exposes only bounded safe context
The system SHALL expose known provider/model and durable runtime identities when
available while omitting raw or sensitive execution content.

#### Scenario: Runtime metadata is present
- **WHEN** durable records identify a session, parent session, delegation, role,
  task, integration attempt, or resolved candidate
- **THEN** live status includes those exact sanitized identifiers

#### Scenario: Metadata is incomplete
- **WHEN** a historical or single-agent run lacks optional identities
- **THEN** live status uses null fields and remains renderable

#### Scenario: Sensitive source fields exist
- **WHEN** source records contain prompts, diffs, commands, diagnostics, or provider payloads
- **THEN** live status omits those fields and caps normalized safe summary text at 500 characters
