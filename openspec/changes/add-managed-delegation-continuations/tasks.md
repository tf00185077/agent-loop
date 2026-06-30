## 1. Domain and Persistence Contracts

- [ ] 1.1 Add domain types for delegation role, parent session id, child session id, child status, worktree metadata, merge outcome, and detached/ignored result state.
- [ ] 1.2 Add persistence schema and repository methods for parent-child session relationships and delegation status transitions.
- [ ] 1.3 Add durable event payload types for delegation requested, accepted, rejected, started, completed, failed, detached, merge applied, merge reverted, and verification failed.
- [ ] 1.4 Add unit tests for delegation state transitions, one-active-child enforcement, and max-depth enforcement.

## 2. Delegation Control Event Handling

- [ ] 2.1 Define the provider-agnostic structured delegation control-event schema.
- [ ] 2.2 Implement parser/validator logic that accepts valid delegation control events and rejects malformed or unauthorized events.
- [ ] 2.3 Add runtime tests for valid worker spawn requests, invalid role fields, duplicate active child requests, and nested child requests.

## 3. Child Session and Worktree Runtime

- [ ] 3.1 Implement a worktree service that creates isolated child git worktrees and records their paths.
- [ ] 3.2 Implement backend child session spawning for the `worker` role using the child worktree as cwd.
- [ ] 3.3 Implement child completion handling that records success, failure, timeout, and cancellation summaries.
- [ ] 3.4 Implement supervisor continuation after child completion using provider resume when available and fresh continuation fallback otherwise.
- [ ] 3.5 Add tests proving child failures continue the supervisor as observations rather than failing the parent goal automatically.

## 4. Detached Child Handling

- [ ] 4.1 Implement supervisor cancellation behavior that leaves active children running.
- [ ] 4.2 Implement detached/ignored result recording when a child finishes after its supervisor is terminal.
- [ ] 4.3 Add tests for supervisor cancel while child runs and late detached child completion.

## 5. Review Merge Gate

- [ ] 5.1 Implement `review_merge` child spawning initiated by the supervisor.
- [ ] 5.2 Add supervisor workspace checkpoint and clean-workspace verification before review merge starts.
- [ ] 5.3 Implement merge outcome validation for `merged`, `rejected`, `conflict`, `test_failed_reverted`, `revert_failed`, `failed`, and `verification_failed`.
- [ ] 5.4 Run the configured fixed test command after apply and require evidence before accepting `merged`.
- [ ] 5.5 Automatically verify revert state when tests fail after apply.
- [ ] 5.6 Add integration tests for merge success, conflict, test failure with revert, and verification failure.

## 6. API and Dashboard Observability

- [ ] 6.1 Extend backend goal/run snapshot APIs with delegation tree and merge outcome read models.
- [ ] 6.2 Render child session role, status, worktree label/path, parent relation, and final outcome in the dashboard.
- [ ] 6.3 Render review merge diff/test/revert status in the dashboard timeline.
- [ ] 6.4 Add UI/API tests for active child state, detached result state, and merge outcome display.

## 7. Verification and Documentation

- [ ] 7.1 Document the v1 delegation limits and transport shape in project docs.
- [ ] 7.2 Run `npm run typecheck`.
- [ ] 7.3 Run `npm test`.
- [ ] 7.4 Run `openspec validate add-managed-delegation-continuations --strict`.
