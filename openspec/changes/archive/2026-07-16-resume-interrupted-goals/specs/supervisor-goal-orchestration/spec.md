## ADDED Requirements

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
