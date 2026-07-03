## 1. Domain and Persistence Contracts

- [x] 1.1 Add domain types for delegation role, request status, child outcome, detached/ignored result state, and safe result summary.
- [x] 1.2 Add persistence schema for durable delegation requests/claims linked to parent and child sessions.
- [x] 1.3 Add repository methods for creating, accepting, rejecting, starting, completing, failing, cancelling, timing out, detaching, and ignoring delegation requests.
- [x] 1.4 Add durable event payload types for delegation accepted, rejected, started, completed, failed, cancelled, timed out, detached, ignored, waiting-child, and continuation-started.
- [x] 1.5 Add unit tests for allowed state transitions, rejected transitions, one-active-child enforcement, and max-depth enforcement.

## 2. Control Event Parsing and Validation

- [x] 2.1 Define the provider-neutral structured delegation control-event schema for `worker` requests.
- [x] 2.2 Implement parser/validator logic that accepts valid delegation requests and rejects malformed or unauthorized events.
- [x] 2.3 Integrate validation with managed runtime event handling without embedding scheduling side effects in event persistence.
- [x] 2.4 Add tests for valid worker requests, invalid role fields, duplicate active child requests, and nested child requests.

## 3. Delegation Coordinator

- [ ] 3.1 Add a delegation coordinator service that owns request acceptance, child spawning, outcome recording, and supervisor continuation decisions.
- [ ] 3.2 Implement backend child session spawning for the `worker` role using managed runtime adapter APIs.
- [ ] 3.3 Record supervisor waiting-child state and durable waiting-child events after a child starts.
- [ ] 3.4 Implement child completion handling for success, failure, timeout, and cancellation summaries.
- [ ] 3.5 Add tests proving child failures continue the supervisor as observations rather than failing the parent goal automatically.

## 4. Supervisor Continuation and Detached Handling

- [ ] 4.1 Implement supervisor continuation after child completion using provider resume when available.
- [ ] 4.2 Implement fresh supervisor continuation fallback when true resume is unavailable.
- [ ] 4.3 Implement supervisor cancellation behavior that leaves active children running.
- [ ] 4.4 Implement detached/ignored result recording when a child finishes after its supervisor is terminal.
- [ ] 4.5 Add tests for resume continuation, fresh continuation fallback, supervisor cancel while child runs, and late detached child completion.

## 5. API and Dashboard Observability

- [ ] 5.1 Extend backend goal/session snapshot APIs with delegation tree and basic child outcome read models.
- [ ] 5.2 Render child session role, status, parent relation, safe summary, and final outcome in the dashboard.
- [ ] 5.3 Refresh dashboard managed-session snapshots on delegation lifecycle events.
- [ ] 5.4 Add API/UI tests for active child state, child result state, detached result state, and continuation-started display.

## 6. Verification and Documentation

- [ ] 6.1 Document v1 delegation limits and structured transport shape in project docs.
- [ ] 6.2 Run `npm run typecheck`.
- [ ] 6.3 Run `npm test`.
- [ ] 6.4 Run `openspec validate add-managed-delegation-core --strict`.
