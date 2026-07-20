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
The system SHALL carry a per-goal confirmation policy (`required` by default, or `off`)
that is owned by the caller and set when the goal is created; the supervisor SHALL have
no control block that reads or changes it, so the policy is never bypassable by the
agent. Under `required`, the system SHALL reject a work-producing control block —
`managed_delegation.request` or `managed_change.plan` — unless a standing caller
confirmation exists for the goal, with a durable safe reason instructing the supervisor
to propose its plan and reach `ready_to_proceed` first. A `plan_confirmation` conversation
that closes by supervisor `ready_to_proceed` or caller `proceed` SHALL record the standing
confirmation. The standing confirmation SHALL be cleared — re-arming the checkpoint —
whenever the supervisor subsequently emits a plan-defining control block
(`managed_change.plan`, which also opens the next epoch, or a mid-epoch
`managed_delegation.task_list`). Under `off`, no checkpoint SHALL be enforced.

#### Scenario: Work without confirmation is rejected under the required policy
- **WHEN** a `required`-policy goal's supervisor emits a delegation or change plan with no standing confirmation
- **THEN** the backend rejects it and instructs the supervisor to propose a plan and reach ready_to_proceed first

#### Scenario: The supervisor cannot disable the policy
- **WHEN** a `required`-policy goal's supervisor emits any control block attempting to skip or change the confirmation policy
- **THEN** the backend does not honor it as a policy change and the checkpoint still applies

#### Scenario: Confirmed plan admits work
- **WHEN** a `plan_confirmation` conversation has closed with a standing confirmation
- **THEN** the supervisor's work-producing control blocks are accepted until the confirmation is cleared

#### Scenario: A restated plan re-arms the checkpoint
- **WHEN** the supervisor emits a new `managed_change.plan` or a mid-epoch `managed_delegation.task_list` after a confirmation was granted
- **THEN** the standing confirmation is cleared and the next work-producing block requires a fresh confirmation

#### Scenario: Off policy keeps the autonomous flow
- **WHEN** a goal's caller-set confirmation policy is `off`
- **THEN** work-producing control blocks are accepted with no confirmation checkpoint
