# Tasks — caller-escalation-contract

## 1. Domain and persistence

- [x] 1.1 Add `GoalInputRequest` domain types: reason-code union, payload shape (evidence, gaps, budget name + effective value, allowed decisions), response union (`extend_budget` | `provide_guidance` | `abandon`), request status union; export through `src/domain/index.ts` (TDD: type-contract test first)
- [x] 1.2 Add `goal_input_requests` table and repository (create/getPending/listForGoal/resolve) in `src/persistence/` following existing repo patterns; enforce at most one pending request per goal at the repository layer
- [x] 1.3 Repository tests: single-pending invariant, resolve transitions (accepted/abandoned/cancelled), payload round-trip

## 2. Escalation at the block sites

- [x] 2.1 Failing tests: epoch-budget exhaustion and repeated-gap circuit breaker produce a durable input request + `waiting_user` (not `blocked`), close the supervisor session, and start no provider work
- [x] 2.2 Redirect `blockGoalForMacroLoop` to record the input request (reason-specific allowed decisions, reassessment evidence/gaps in payload) and set `waiting_user`; keep unrecoverable block sites (archive capability, lineage recovery) writing terminal `blocked`
- [x] 2.3 Failing test + implementation: continuation exhaustion escalates with reason `continuation_exhausted`
- [x] 2.4 Durable events: `goal.input_requested` written before the status update; event data sanitized

## 3. Response validation and application

- [x] 3.1 Failing tests: decision-not-allowed, out-of-range extension, empty guidance, response to non-pending request — all rejected with safe reasons, request stays pending, goal unchanged
- [x] 3.2 Implement deterministic response validation in the manager (mirror of control-block validation; no prompt-text enforcement)
- [x] 3.3 Implement effective-budget derivation: base + accepted grants (bounded 1..base per grant); switch epoch-budget and continuation checks to effective values; `provide_guidance` on budget reasons implies +1
- [x] 3.4 Implement `abandon`: request resolved, goal to terminal `blocked` with caller-attributed durable reason
- [x] 3.5 Durable events: `goal.input_response` (accepted and rejected variants) written before side effects

## 4. Resume as fresh continuation

- [x] 4.1 Failing test: accepted guidance/extension resumes the goal — registries rehydrated, fresh supervisor session started, continuation prompt carries the caller decision as an observation, goal back to `running`
- [x] 4.2 Implement resume reusing the fresh branch of `continueSupervisorAfterChild` + `supervisor-state-rehydration` (cold path: no active handle); deterministic observation rendering for each decision kind
- [x] 4.3 Failing test + implementation: post-resume loop honors extended budgets end to end (next unsatisfied reassessment admits an epoch under base+grant; continuation counter continues under extended bound)

## 5. Restart and cancellation stability

- [ ] 5.1 Failing tests: startup reconciliation leaves a `waiting_user` goal untouched (not interrupted, not resumed) and worktree reclamation skips its worktrees
- [ ] 5.2 Add `waiting_user` to the reconciliation/reclamation stable sets; verify a caller response after restart validates and applies from durable state alone
- [ ] 5.3 Failing test + implementation: cancelling a `waiting_user` goal resolves the pending request as cancelled and follows the existing cancellation flow
- [ ] 5.4 Rehydration test: accepted grants recompute the same effective budgets after restart

## 6. API endpoints

- [ ] 6.1 Failing route tests: `GET /api/goals/:id/input-request` (pending → structured JSON; none → 404), `POST /api/goals/:id/input-request/:requestId/respond` (valid → applied; invalid → 400 with safe reason; already-resolved → 409 naming the standing resolution)
- [ ] 6.2 Implement the goal-scoped routes (modeled on `agent-sessions.ts` approval routes); sanitize all outgoing payloads; wire into `src/backend/app.ts`

## 7. Dashboard

- [ ] 7.1 `waiting_user` status badge treatment in goal list/detail; live-status panel already maps the state — verify
- [ ] 7.2 Pending-request panel on goal detail: reason, summary, gaps, and exactly the allowed decisions (extension number input / guidance textarea / abandon confirm); submit via the new endpoints
- [ ] 7.3 Panel refresh on event-stream signal; 409 standing-resolution rendering; component tests following `agent-session-controls-rendering.test.tsx`

## 8. Verification and archive

- [ ] 8.1 `npm test` and `npm run typecheck` green
- [ ] 8.2 Live smoke: start API, drive a goal to epoch-budget escalation (low budget), read the input request via API, respond `extend_budget`, confirm resume events, then a second escalation answered with `abandon` → terminal `blocked`; restart backend mid-wait and answer after restart; record evidence in `verification.md`
- [ ] 8.3 Update README capability notes; commit per task group throughout
