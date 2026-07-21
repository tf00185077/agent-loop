# supervisor-goal-orchestration Specification

## Purpose

Define how a managed supervisor session turns one large user goal into an executed result: the bootstrap prompt contract, durable task decomposition, sequential per-task worker delegation, iterate-until-done continuation behavior, explicit completion signaling, and provider-neutral control-block extraction.
## Requirements
### Requirement: Supervisor bootstrap prompt contract
The system SHALL start a managed supervisor session with a generated bootstrap prompt that includes the goal title and description, the supervisor role framing, instructions to decompose the goal into an ordered task list with per-task acceptance criteria before delegating, instructions to delegate exactly one worker task at a time, instructions to request a review-merge child after worker results that changed files, the rule that criterion identifiers are frozen and rejections must cite them, and the exact fenced control-block output format with the rule that only fenced control blocks are honored.

#### Scenario: Managed goal starts with the orchestration prompt
- **WHEN** a goal starts through the managed supervisor path
- **THEN** the supervisor session's initial prompt contains the goal context, decomposition-with-acceptance instructions, the frozen-criteria and citation rules, the delegation control-block format, and the completion control-block format

#### Scenario: Continuation prompts re-carry the contract
- **WHEN** a supervisor continuation starts without true resume support
- **THEN** the continuation prompt contains the child result observation together with the same control-block contract sections as the bootstrap prompt

### Requirement: Durable task decomposition
The system SHALL record the supervisor's announced task decomposition as durable event data so the task list survives refresh and backend restart, and each announced task SHALL carry acceptance criteria with stable identifiers and binary, testable text.

#### Scenario: Supervisor announces a task list
- **WHEN** supervisor output announces the ordered task list for the goal
- **THEN** the backend persists a durable event carrying the task list, including each task's acceptance criteria, as safe metadata

#### Scenario: Delegations reference tasks
- **WHEN** a supervisor delegation control block includes a task identifier
- **THEN** the persisted delegation request records that task identifier and delegation lifecycle events carry it as safe metadata

#### Scenario: Task without criteria cannot be delegated
- **WHEN** a supervisor announces a task without acceptance criteria and then delegates it
- **THEN** the backend rejects the delegation with a durable reason naming the missing acceptance contract

### Requirement: Continuations carry the durable task history
The system SHALL render the goal's SQLite-backed task history into supervisor continuation and nudge prompts: each task's identifier, title, status, attempt count, substantive rejection count, per-criterion authoritative outcome, last safe result summary, last judge decision, and delivery state, so a continuation does not require the supervisor to re-derive prior work from AI response history.

#### Scenario: Continuation after a worker result includes durable history
- **WHEN** a supervisor continuation starts after a child outcome for a goal with registered tasks
- **THEN** the continuation lists every task with its persisted current status and shows which criteria passed, failed, are blocked, or remain unknown

#### Scenario: History reflects review, delivery, and splits
- **WHEN** a task has a judge decision, pending or completed delivery, substantive rejections, or narrower descendants
- **THEN** the continuation shows the decision, delivery status, rejection count, cited criteria, and lineage from durable state

#### Scenario: Continuation is rebuilt after restart
- **WHEN** the backend builds a continuation after reopening SQLite
- **THEN** the rendered task history is equivalent to the last committed durable state before restart

### Requirement: Iterate until explicit completion
The system SHALL continue a managed supervisor across multiple delegation cycles until the supervisor emits an explicit completion signal or a terminal failure, cancellation, or configured bound is reached; provider process exit alone SHALL NOT complete the goal. The continuation bound SHALL be the goal's effective continuation bound (configured base plus accepted caller grants), and reaching it SHALL escalate to the goal's caller as a durable input request instead of terminally blocking the goal.

#### Scenario: Multi-task goal runs task by task
- **WHEN** a supervisor decomposes a goal into multiple tasks and delegates them sequentially
- **THEN** each worker result returns to the supervisor as an observation and the supervisor continues to the next delegation without user input

#### Scenario: Session exits without completion signal
- **WHEN** a supervisor session ends without a completion signal and without a pending delegation
- **THEN** the backend starts a supervisor continuation prompting the supervisor to continue or complete, and records a durable continuation event

#### Scenario: Continuation bound reached
- **WHEN** the number of completion-less supervisor continuations reaches the goal's effective continuation bound
- **THEN** the backend records a durable `continuation_exhausted` input request and moves the goal to `waiting_user` instead of continuing or terminally blocking

#### Scenario: Granted continuations extend the bound
- **WHEN** a caller's accepted response grants additional continuations and the goal resumes
- **THEN** subsequent continuation checks use the extended effective bound and the continuation history reflects the pre-escalation cycles

### Requirement: Explicit supervisor completion signal
The system SHALL treat a valid `managed_delegation.complete` control block as a completion request and SHALL complete the managed goal only when the backend completion evaluator verifies the durable task, criterion, review, delivery, and change-plan gates.

#### Scenario: Completion request passes all gates
- **WHEN** supervisor output contains a valid completion block and every registered leaf task is accepted, every required criterion is `PASS`, no attempt/review/delivery is pending, no attested changes are undelivered, and all planned changes are archived when a plan exists
- **THEN** the backend atomically marks the run and goal completed and records the safe result summary in terminal events

#### Scenario: Completion request has durable gaps
- **WHEN** a valid completion block is emitted while any required task, criterion, review, delivery, or change-plan condition is incomplete
- **THEN** the backend rejects the request without completing the goal
- **AND** it records and returns a structured safe list of completion gaps in the next continuation

#### Scenario: Malformed completion block
- **WHEN** supervisor output contains an invalid completion block
- **THEN** the backend records a rejection with a safe reason and the goal remains in its current state

#### Scenario: Split task completion follows accepted descendants
- **WHEN** a parent task was split under the narrowing rule
- **THEN** the completion evaluator treats it as satisfied only when it has at least one narrower descendant and every required leaf descendant is accepted

### Requirement: Control-block extraction from provider text
The system SHALL extract fenced control blocks from provider assistant text through a provider-neutral extraction step, strip them from user-visible progress messages, and pass surrounding text through normal sanitized progress handling.

#### Scenario: Message mixes prose and a control block
- **WHEN** an assistant message contains prose and one fenced control block
- **THEN** the control block is parsed and handled as a control event, the prose is persisted as sanitized progress, and no fenced block text appears in durable event messages

#### Scenario: Malformed control block is rejected visibly
- **WHEN** an assistant message contains a fenced control block with invalid JSON or an unsupported type
- **THEN** the backend records a durable rejection event with a safe reason and the supervisor's next continuation includes that reason

### Requirement: Scale assessment in the bootstrap contract
The supervisor bootstrap prompt SHALL document goal scale assessment: the change-plan control block format, sizing guidance for when to split a goal into multiple changes, and the rule that small goals proceed with a flat task list.

#### Scenario: Bootstrap documents the change plan
- **WHEN** a managed goal starts
- **THEN** the bootstrap prompt contains the `managed_change.plan` format with an example and sizing guidance for choosing between a flat task list and a change plan

### Requirement: Task decomposition references the active change
The system SHALL associate task lists and worker delegations announced under a change plan with the active change identifier, inheriting it when absent and rejecting explicit mismatches.

#### Scenario: Task list inherits the active change
- **WHEN** a supervisor announces a task list while a change is active without naming a change
- **THEN** the registered tasks carry the active change identifier in durable metadata

#### Scenario: Mismatched change reference is rejected
- **WHEN** a task list or worker delegation names a change other than the active one
- **THEN** the backend rejects it with a safe reason naming the active change

### Requirement: Continuations carry change-level history
The system SHALL render change-plan state into supervisor continuation and nudge prompts when a plan exists: each change's identifier, title, status, and the active change's task summary.

#### Scenario: Continuation shows plan progress
- **WHEN** a supervisor continuation starts for a goal with a change plan
- **THEN** the prompt lists every planned change with its status and identifies the active change alongside the existing task history

### Requirement: Background supervisor run failures are durable

The system SHALL treat the goal's background supervisor run as an observed
operation: any failure that would otherwise escape the background run
unhandled (an unhandled promise rejection or thrown error not already recorded
through the normal durable-event path) SHALL be recorded as a durable failure
event for the goal and SHALL transition the goal to a durable terminal failure
status, rather than being reported only through a console log.

This requirement is an outermost safety net. Failures that the runtime already
records durably through its normal event flow SHALL NOT be double-recorded, and
the goal status SHALL end in a terminal failure state exactly once.

#### Scenario: Background run rejects without a durable trace

- **WHEN** a goal's background supervisor run rejects with an error that was not
  already recorded through the normal durable-event path
- **THEN** the backend persists a durable failure event for the goal and
  transitions the goal to a terminal failure status

#### Scenario: Already-durable failure is not double-recorded

- **WHEN** a goal's background supervisor run ends after the runtime has already
  recorded the failure durably and set a terminal goal status
- **THEN** the outermost safety net adds no duplicate failure event and does not
  change the already-terminal goal status

### Requirement: Interrupted goals resume from a durable projection on startup

The system SHALL resume, on startup after reconciliation, each goal in the
durable `interrupted` status by starting a fresh managed supervisor session
driven by a continuation prompt projected from durable state, and SHALL flip the
goal back to `running`. Before building the prompt the system SHALL rehydrate the
goal's in-memory task and change registries from durable rows so the continuation
reflects the ledger; the durable projection remains the authoritative state. The
resumed session SHALL be started from a continuation phase, never a bootstrap
phase, so prior work is not re-decomposed. Resume SHALL be best-effort: a resume
that cannot start is recorded durably and leaves the goal visibly non-running,
and a goal that cannot make progress across resumes is bounded by the existing
continuation cap rather than resumed forever.

#### Scenario: Interrupted goal is resumed with a continuation prompt

- **WHEN** the backend starts and finds a goal in `interrupted` status with
  durable task history
- **THEN** it rehydrates the goal's task and change registries from durable rows,
  starts a fresh supervisor session whose prompt is a continuation carrying the
  durable projection, flips the goal to `running`, and records a durable resume
  event

#### Scenario: Non-interrupted goals are not resumed

- **WHEN** the backend starts and a goal is not in `interrupted` status
- **THEN** the backend does not resume that goal

#### Scenario: Crash-to-continue survives a restart end to end

- **WHEN** a goal that was `running` with in-flight work is reconciled to
  `interrupted` on restart and then resumed
- **THEN** the goal returns to `running` under a fresh supervisor session that
  continues from the durable ledger rather than restarting the goal from scratch

#### Scenario: Failed resume is durable and does not spin

- **WHEN** resuming an interrupted goal fails to start its session
- **THEN** the failure is recorded durably and the goal is left visibly
  non-running rather than silently retried without bound

### Requirement: Goal completion and change archive share lineage semantics
The system SHALL use the shared durable task-lineage projection for every managed Goal completion evaluation. A split parent SHALL be satisfied only through its valid required leaf closure, and an invalid graph SHALL produce `invalid_split_lineage` with the same task IDs and reason that block the owning change's archive.

#### Scenario: Archive and completion inspect the inconsistent graph
- **WHEN** a parent has a persisted child but lacks a valid durable `split` transition
- **THEN** both the active-change archive attempt and Goal completion request fail closed with `invalid_split_lineage`
- **AND** neither gate interprets the parent as a delivered or ignorable non-leaf

#### Scenario: Valid split lineage completes through descendants
- **WHEN** a parent is durably `split`, its frozen descendant graph is valid, every required leaf is accepted, and every other completion gate passes
- **THEN** the parent is satisfied through those descendants for both archive and Goal completion

### Requirement: Existing blocked Goals require explicit lineage recovery
The system SHALL provide a local offline operator recovery whose default mode is read-only dry-run and whose apply mode requires a verified backup and the exact dry-run plan digest. Recovery SHALL be eligible only for a `blocked` Goal with continuation-exhaustion provenance, quiescent runs/sessions/task pipelines, no ambiguous migration diagnostic, a valid shared lineage projection, and one coherent change/workspace/Git recovery plan. Failed preconditions SHALL leave all state unchanged.

#### Scenario: Dry-run evaluates an incident-shaped Goal
- **WHEN** an operator targets an existing blocked Goal without apply authorization
- **THEN** the command reports bounded eligible repairs, archive reconciliation, lifecycle transition, blockers, and a deterministic plan digest without changing SQLite, files, Git, provider sessions, or Goal state

#### Scenario: Proven provider-created archive is adopted explicitly
- **WHEN** the active directory is absent, exactly one matching dated archive strictly validates, its manifest matches delivered evidence, Git history proves one coherent archive commit, all durable gates pass, and apply authorization matches the dry-run digest
- **THEN** recovery records operator authorization, a reconciled archive operation, and exactly one `change.archived` event without moving or rewriting the archive files

#### Scenario: Eligible blocked Goal is prepared for fresh continuation
- **WHEN** all authorized recovery steps commit successfully
- **THEN** the backend transitions the Goal from `blocked` to `interrupted`, clears only its terminal timestamp, preserves old runs/sessions/events/task evidence, and starts no provider work in the recovery command
- **AND** a later normal backend restart may use existing interrupted-Goal behavior to start a fresh durable-projection continuation

#### Scenario: Ambiguous blocked Goal stays blocked
- **WHEN** lineage, archive directories, manifests, Git provenance, pending pipeline state, terminal reason, backup, or plan digest is missing or ambiguous
- **THEN** recovery performs no partial write or workspace mutation and the Goal remains `blocked`

#### Scenario: Frozen-contract migration diagnostic is ambiguous
- **WHEN** the frozen-contract or split-lineage migration marker names a task in the selected Goal as ambiguous
- **THEN** recovery reports the normalized task diagnostic and remains read-only and ineligible even if the task is accepted and its current criteria pass

#### Scenario: Stopped-backend evidence is stale
- **WHEN** apply evidence does not bind the selected Goal to the exact pre-apply database digest and current workspace HEAD
- **THEN** recovery rejects apply as stale and performs no write

#### Scenario: Idempotent replay postconditions are incomplete
- **WHEN** an authorization row exists but the Goal is not interrupted, the authorized archive operation/SHA is missing or mismatched, or the uniquely cross-linked `change.archived` event is missing, duplicated, or tampered
- **THEN** replay fails closed instead of trusting the authorization row or reporting an idempotent success

#### Scenario: Idempotent replay workspace proof changed
- **WHEN** the authorized archive target is missing or modified, its source/target topology or manifest no longer matches, the workspace is dirty, or Git no longer proves the recorded coherent archive commit
- **THEN** replay fails closed without changing SQLite or reporting an idempotent success

#### Scenario: Restart cannot reset pending delivery
- **WHEN** interrupted-Goal reconciliation lacks a pending delivery's recorded clean checkpoint, lacks the reconciliation capability, or cannot restore the checkpoint
- **THEN** the backend records a durable recovery blocker, leaves the Goal non-resumable in `blocked`, and starts no provider continuation

#### Scenario: Ignored artifact prevents exact checkpoint proof
- **WHEN** a non-disposable supervisor workspace contains an ignored artifact outside the explicit protected local-input allowlist during pending-delivery reconciliation
- **THEN** the backend does not delete the artifact, records a durable reset blocker, and leaves the Goal non-resumable
- **AND** explicitly protected local inputs such as credentials, dependencies, and managed worktree roots are retained

### Requirement: Split-lineage repair does not redefine continuation policy
The system SHALL preserve the configured supervisor continuation maximum, the existing classification and increment behavior for completion-less and control-rejected turns, counter reset behavior, and terminal exhaustion diagnostics while applying this split-lineage repair.

#### Scenario: Continuation bound is unchanged
- **WHEN** a managed Goal encounters turns unrelated to the repaired lineage transition
- **THEN** continuation accounting and exhaustion behavior match the pre-change contract

#### Scenario: Lineage repair advances without a budget workaround
- **WHEN** the valid child set commits and its leaf descendants satisfy delivery
- **THEN** archive and completion advance from corrected durable state without adding, resetting, or bypassing a continuation budget

### Requirement: Supervisor caller-input requests
The system SHALL accept a `managed_goal.request_input` control block from a managed
goal's supervisor only when deterministic gates pass: the block carries a non-empty
question within the configured length bound and at most the configured number of
bounded context strings; the goal has no pending input request; the emitting session
has no in-flight child delegation; and the goal has not exhausted its per-goal
question budget (configurable, default 3, counted from durable question requests of
any status). Every rejection SHALL be durable and carry a safe reason that teaches
the correct next action, including instructing an over-budget supervisor to decide
autonomously and proceed. Prompt text SHALL only inform; these gates are backend
enforcement.

#### Scenario: Valid question parks the goal
- **WHEN** a supervisor with no in-flight delegation and remaining question budget emits a well-formed question block
- **THEN** the backend records the request durably, the goal moves to `waiting_user`, and the ending session starts no continuation

#### Scenario: Question during an in-flight delegation is rejected
- **WHEN** a supervisor emits a question block while a child delegation is requested, accepted, or running
- **THEN** the backend rejects it with a durable safe reason telling the supervisor to wait for the child observation first, and goal state is unchanged

#### Scenario: Question budget exhaustion teaches autonomy
- **WHEN** a supervisor emits a question block after the goal's question budget is exhausted
- **THEN** the backend rejects it with a durable safe reason instructing the supervisor to decide autonomously using its best judgment, and the loop continues

#### Scenario: Malformed question is rejected
- **WHEN** a question block has an empty or oversized question or oversized context strings
- **THEN** the backend rejects it with a durable safe reason naming the bounds

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
The system SHALL carry a per-goal confirmation policy (`off` by default, or `required`)
that is owned by the caller and set when the goal is created; the supervisor SHALL have
no control block that reads or changes it, so the policy is never bypassable by the
agent. Under `required`, the system SHALL reject the work-dispatch control block
`managed_delegation.request` unless a standing caller confirmation exists for the goal,
with a durable safe reason instructing the supervisor to propose its plan and reach
`ready_to_proceed` first. A `plan_confirmation` conversation that closes by supervisor
`ready_to_proceed` or caller `proceed` SHALL record the standing confirmation. The
standing confirmation SHALL be cleared — re-arming the checkpoint — whenever the
supervisor emits a `managed_change.plan` (opening or re-planning an epoch), so each
epoch's work requires a fresh confirmation. The projection SHALL be derived from durable
events so it survives restart. Under `off`, no checkpoint SHALL be enforced.

#### Scenario: Work without confirmation is rejected under the required policy
- **WHEN** a `required`-policy goal's supervisor requests a worker delegation with no standing confirmation
- **THEN** the backend rejects it and instructs the supervisor to propose a plan and reach ready_to_proceed first

#### Scenario: The supervisor cannot disable the policy
- **WHEN** a `required`-policy goal's supervisor emits any control block attempting to skip or change the confirmation policy
- **THEN** the backend does not honor it as a policy change and the checkpoint still applies

#### Scenario: Confirmed plan admits work
- **WHEN** a `plan_confirmation` conversation has closed with a standing confirmation
- **THEN** the supervisor's worker delegations are accepted until the confirmation is cleared

#### Scenario: A new epoch re-arms the checkpoint
- **WHEN** the supervisor emits a `managed_change.plan` after a confirmation was granted
- **THEN** the standing confirmation is cleared and the next delegation requires a fresh confirmation

#### Scenario: Off policy keeps the autonomous flow
- **WHEN** a goal's caller-set confirmation policy is `off`
- **THEN** worker delegations are accepted with no confirmation checkpoint

### Requirement: Goals run in their own workspace
The system SHALL run a goal's supervisor and its workers in the goal's workspace directory: worktree creation and removal, OpenSpec scaffold/validate/archive, git and acceptance-check command execution, and workspace-path sanitization SHALL all resolve to the goal's workspace, or to the server's default workspace when the goal has none. The workspace SHALL be caller-owned and unreadable and unchangeable by any control block, and the resolution SHALL be derived from the durable goal record so it holds across restart, recovery, and continuation.

#### Scenario: Work happens in the goal's workspace
- **WHEN** a goal with a workspace runs and creates a worker worktree or executes a command
- **THEN** the worktree and command use the goal's workspace as their parent directory

#### Scenario: Default workspace when none is set
- **WHEN** a goal with no workspace runs
- **THEN** its work uses the server's default workspace, unchanged from prior behavior

#### Scenario: Workspace is not settable by the agent
- **WHEN** a supervisor emits any control block attempting to read or change the workspace
- **THEN** the backend does not honor it as a workspace change and the goal keeps its caller-set workspace

#### Scenario: Recovery keeps the goal's workspace
- **WHEN** a goal is reconciled or resumed after a restart
- **THEN** its recovered work resolves to the same goal workspace it had before

### Requirement: Workspace cleanliness ignores the runtime database
Every workspace git-cleanliness gate that runs in a goal's supervisor workspace — delivery, integration, review-merge, OpenSpec scaffold/archive, and recovery — SHALL disregard changes to the runtime's own database file and its `-wal`/`-shm`/`-journal` sidecars when judging whether the workspace is clean, so a goal may run inside the auto-agent repository itself without the runtime's own live writes being seen as a dirty workspace. The ignored set SHALL be derived from the actual configured database path; any other modified or untracked path SHALL still make the workspace dirty.

#### Scenario: A goal runs inside the auto-agent repo
- **WHEN** a goal's workspace is the auto-agent repository and the runtime has written to its committed database during the run
- **THEN** the delivery, integration, review-merge, OpenSpec, and recovery cleanliness gates treat the workspace as clean with respect to those database files

#### Scenario: A real change still fails the gate
- **WHEN** a goal's workspace has an uncommitted change to any path other than the runtime database files
- **THEN** the cleanliness gate still reports the workspace dirty and names that path
