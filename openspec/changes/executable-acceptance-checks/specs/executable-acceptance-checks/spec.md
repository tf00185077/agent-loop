# executable-acceptance-checks

Backend-executed acceptance checks: check contracts frozen with criteria, execution at review time, red-green/regression discrimination against the baseline, protected-path enforcement, and durable execution evidence.

## ADDED Requirements

### Requirement: Check definitions freeze with the acceptance contract
The system SHALL accept an optional executable check per acceptance criterion (`kind` of `red_green`, `regression`, or `command`; a non-empty command; optional bounded timeout; optional repo-relative protected paths), validated deterministically in the task-list control block and frozen with the criterion; restated or mutated checks for a known task SHALL be ignored with the existing mutation-ignored bookkeeping.

#### Scenario: Check frozen at announcement
- **WHEN** a task list announces a criterion with a valid check definition
- **THEN** the backend persists the check with the frozen criterion before any delegation

#### Scenario: Malformed check rejected
- **WHEN** a check has an unknown kind, an empty command, or non-string protected paths
- **THEN** the backend rejects the task list with a durable safe reason naming the defect

#### Scenario: Restated check ignored
- **WHEN** a later task list restates a known task's check with different content
- **THEN** the backend keeps the frozen check and records the ignored mutation

### Requirement: Checks execute at review time under backend authority
When a review-merge is dispatched for a worker attempt whose task has checked criteria, the system SHALL execute each check in the worker's worktree before the judge starts, SHALL persist one durable execution record per criterion and attempt (command, kind, exit code, duration, sanitized truncated output), SHALL stamp the criterion outcome from the exit code, and SHALL include the execution results in the judge's context. A check that cannot start or times out SHALL record a visible failed execution treated as FAIL.

#### Scenario: Passing check stamps PASS
- **WHEN** a checked criterion's command exits 0 in the worker worktree
- **THEN** the criterion outcome is PASS by execution and the judge packet shows the result

#### Scenario: Failing check stamps FAIL
- **WHEN** a checked criterion's command exits nonzero
- **THEN** the criterion outcome is FAIL by execution with the sanitized output persisted

#### Scenario: Unrunnable check fails closed
- **WHEN** a check times out or its command cannot start
- **THEN** the backend records a durable failed execution for that criterion and the attempt cannot be accepted on that criterion

### Requirement: Red-green and regression discrimination against the baseline
For `red_green` checks the system SHALL also execute the same command against a baseline worktree at the base the worker branched from and SHALL reject the attempt with a teaching reason when the baseline run passes (the check does not discriminate the change). For `regression` checks the baseline run SHALL pass and the candidate run SHALL pass; a failing baseline SHALL be surfaced as a contract-authoring error. `command` checks run candidate-only.

#### Scenario: Vacuous test rejected
- **WHEN** a red_green check passes on both the baseline and the candidate
- **THEN** the backend rejects the attempt naming the check and both results

#### Scenario: Genuine red-green accepted
- **WHEN** a red_green check fails on the baseline and passes on the candidate
- **THEN** the criterion outcome is PASS by execution

#### Scenario: Regression keeps the suite green
- **WHEN** a regression check passes on the baseline and on the candidate
- **THEN** the criterion outcome is PASS by execution

#### Scenario: Broken regression baseline is a contract error
- **WHEN** a regression check fails on the baseline
- **THEN** the backend records a durable contract-error reason and does not charge the worker's retry budget

### Requirement: Protected paths are untouchable by the checked worker
The system SHALL reject a worker attempt whose backend-attested changed files intersect the union of its task's protected paths, with a deterministic safe reason naming the files; the party that must pass a check SHALL NOT be able to modify it.

#### Scenario: Worker edits a protected test
- **WHEN** an attempt's attested diff includes a path listed in a check's protectedPaths
- **THEN** the backend rejects the attempt naming the protected files and no delivery is prepared

#### Scenario: Untouched protected paths pass through
- **WHEN** an attempt's attested diff avoids all protected paths
- **THEN** the protected-path gate is silent and the normal flow continues

### Requirement: Executed outcomes outrank judge prose
For checked criteria the system SHALL treat the executed outcome as authoritative: a judge decision disagreeing with an executed result SHALL be overridden with a durable event naming both, and a judge `accepted` verdict over any executed FAIL SHALL downgrade to a rejection. Unchecked criteria SHALL keep the existing judge-decided flow.

#### Scenario: Judge cannot flip an executed FAIL
- **WHEN** a check failed by execution and the judge marks that criterion PASS with an accepted verdict
- **THEN** the backend records the override durably and the attempt is rejected, not accepted

#### Scenario: Prose-only criteria unchanged
- **WHEN** a task's criteria carry no checks
- **THEN** acceptance behaves exactly as before this change
