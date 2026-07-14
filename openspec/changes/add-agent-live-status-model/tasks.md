## 1. Durable Live-Status Contract

- [ ] 1.1 Add domain tests for closed live `state` and `phase` vocabularies plus nullable safe metadata fields.
- [ ] 1.2 Define and export the compact `AgentLiveStatus` contract without adding persistence schema.
- [ ] 1.3 Add failing projector tests for terminal goal precedence, approval/input, stalled sessions, and missing historical metadata.
- [ ] 1.4 Implement bounded normalization and the terminal/human-waiting/session fallback projection rules.

## 2. Pipeline-Aware Projection

- [ ] 2.1 Add failing projector tests for active Worker, original Judge, Integrator, candidate-bound re-Judge, delivery, continuation, validation, and rollback phases.
- [ ] 2.2 Implement the layered precedence projector using structured records as authority and events only as summary/time fallback.
- [ ] 2.3 Add tests proving stale completion prose cannot override awaiting delivery and stale active sessions cannot override terminal goals.
- [ ] 2.4 Add reopen coverage proving integration interruption and resolved-candidate re-review project equivalently from durable state.

## 3. Backend Snapshot Integration

- [ ] 3.1 Add failing backend tests for `liveStatus` on the existing goal agent-session snapshot.
- [ ] 3.2 Compose the projector from sanitized goal/session/approval/delegation/managed-task/event inputs in the existing route.
- [ ] 3.3 Add backend tests proving prompts, conflict files, checkpoints, commands, diffs, diagnostics, and credential-like values are absent.
- [ ] 3.4 Add compatibility tests for historical goals and terminal states without active sessions or SSE.

## 4. Dashboard Compact Status

- [ ] 4.1 Add failing rendering tests for Worker, Judge, Integrator, re-Judge, delivery, stalled, terminal, and partial-metadata statuses.
- [ ] 4.2 Extend dashboard API types and render a compact current-activity panel above existing managed-session details.
- [ ] 4.3 Keep existing detailed controls, delegation/task tables, and timeline unchanged; use the current event stream only to refresh snapshots.
- [ ] 4.4 Add human-readable labels for every known state/phase and a safe fallback for future unknown values.

## 5. Verification and Documentation

- [ ] 5.1 Update runtime/dashboard documentation with the authority precedence and state/phase model.
- [ ] 5.2 Run focused domain, projector, persistence-reopen, backend, and dashboard tests.
- [ ] 5.3 Run `npm test`, `npm run typecheck`, `openspec validate --all --strict`, and `git diff --check`.
