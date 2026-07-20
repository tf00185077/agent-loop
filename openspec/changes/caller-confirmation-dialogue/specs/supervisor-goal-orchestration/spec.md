# supervisor-goal-orchestration Delta

## ADDED Requirements

### Requirement: Supervisor plan proposals and ready signal
The system SHALL accept a `managed_goal.propose_plan` control block from a managed goal's
supervisor when its summary is a non-empty bounded string and its optional items are
bounded strings, opening a `plan_confirmation` conversation. The system SHALL accept a
`managed_goal.ready_to_proceed` control block only during an open conversational turn;
elsewhere it SHALL be rejected with a durable safe reason. Both blocks SHALL be gated by
the same pending-request, in-flight-delegation, and turn-budget rules as questions, and
prompt text SHALL only inform while these gates enforce.

#### Scenario: A plan proposal opens a confirmation conversation
- **WHEN** a supervisor with no pending request and no in-flight delegation emits a well-formed `managed_goal.propose_plan`
- **THEN** the backend records a `plan_confirmation` request, the goal moves to `waiting_user`, and the ending session starts no continuation

#### Scenario: ready_to_proceed outside a conversation is rejected
- **WHEN** a supervisor emits `managed_goal.ready_to_proceed` when no conversation is open
- **THEN** the backend rejects it with a durable safe reason

### Requirement: Confirmation checkpoint before work
The system SHALL carry a per-goal confirmation policy (`required` by default, or `off`).
Under `required`, the system SHALL reject the first work-producing control block of each
epoch — `managed_delegation.request` or `managed_change.plan` — unless a standing caller
confirmation exists for the current epoch, with a durable safe reason instructing the
supervisor to propose its plan and reach `ready_to_proceed` first. Opening a new epoch
SHALL clear the standing confirmation, re-arming the checkpoint. Under `off`, no
checkpoint SHALL be enforced.

#### Scenario: Work without confirmation is rejected under the required policy
- **WHEN** a `required`-policy goal's supervisor emits its first delegation or change plan of an epoch with no standing confirmation
- **THEN** the backend rejects it and instructs the supervisor to propose a plan and reach ready_to_proceed first

#### Scenario: Confirmed plan admits work
- **WHEN** a `plan_confirmation` conversation has closed with a standing confirmation for the current epoch
- **THEN** the supervisor's work-producing control blocks for that epoch are accepted

#### Scenario: A new epoch re-arms the checkpoint
- **WHEN** the goal opens the next epoch after a satisfied checkpoint
- **THEN** the standing confirmation is cleared and the first work-producing block of the new epoch requires a fresh confirmation

#### Scenario: Off policy keeps the autonomous flow
- **WHEN** a goal's confirmation policy is `off`
- **THEN** work-producing control blocks are accepted with no confirmation checkpoint
