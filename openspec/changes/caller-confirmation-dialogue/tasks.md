# Tasks — caller-confirmation-dialogue

## 1. Domain and persistence — the thread

- [x] 1.1 Extend `GoalInputRequestPayload` with `thread: Array<{ role: "supervisor" | "caller"; text; at }>` and `phase: "awaiting_caller" | "awaiting_supervisor" | "resolved"`; add `plan_confirmation` reason and `proceed` decision; `allowedDecisionsForReason` returns guidance+proceed+abandon for conversation reasons (TDD)
- [x] 1.2 Add `managed_goal.propose_plan` and `managed_goal.ready_to_proceed` to `ManagedControlEventType` with interfaces
- [x] 1.3 Repository: `appendMessage`, `setPhase`, and a standing-confirmation query (per goal + epoch); failing tests for thread round-trip, phase transitions, and confirmation lookup
- [x] 1.4 Goals: nullable `confirmation_policy` column (default `off`), set at goal creation via a caller-facing field and changeable only by a caller action (no control block reads/writes it); repo getter/setter; migration test

## 2. Control-block validation

- [x] 2.1 Failing tests: well-formed `propose_plan` (bounded summary + bounded items) and `ready_to_proceed` accepted; malformed rejected naming the bounds
- [x] 2.2 Implement both validators in `delegation-control-event.ts` (pure, bounded, trimmed)

## 3. Read-only conversational turns

- [x] 3.1 Failing tests: a caller `provide_guidance` reply to a conversation appends to the thread, sets `awaiting_supervisor`, and runs a conversational turn; a work-producing block (delegation/task_list/change_plan/complete) in that turn is rejected read-only; another question/proposal continues the thread (`conversation_continued`, still `waiting_user`)
- [x] 3.2 Implement the conversational-turn path: whitelist enforcement in `persistDelegationControlEvent` keyed on phase `awaiting_supervisor`; reuse `resumeGoalFromDurableProjection` with a conversational prompt; new `respondToGoalInputRequest` outcome `conversation_continued`
- [x] 3.3 Failing test + implementation: `ready_to_proceed` resolves the conversation and resumes a fresh working session whose prompt carries the whole thread
- [x] 3.4 Failing test + implementation: caller `proceed` force-closes and resumes; `abandon` blocks terminally
- [x] 3.5 Failing test + implementation: conversation-turn budget (`maxSupervisorConversationTurns` deps option) exhaustion resolves the conversation with autonomy guidance and, under `required`, records a forced standing confirmation

## 4. Confirm-before-work checkpoint

- [x] 4.1 Failing tests: under `required`, a `managed_delegation.request`/`managed_change.plan` with no standing confirmation is rejected with the propose-first safe reason; after a `plan_confirmation` closes with `ready_to_proceed` (or caller `proceed`), work is accepted; a supervisor cannot bypass or change the policy via any control block
- [x] 4.2 Implement the checkpoint gate + standing-confirmation recording on `plan_confirmation` close (supervisor ready or caller proceed); policy read from the goal, never from a control block
- [x] 4.3 Failing test + implementation: the standing confirmation is cleared by any subsequent plan-defining block (`managed_change.plan` or mid-epoch `managed_delegation.task_list`), re-arming the checkpoint; `off` policy bypasses the checkpoint entirely

## 5. Prompt contract and API

- [x] 5.1 Document in `supervisor-prompt.ts`: propose→confirm before work under a required policy, how to converse and when to signal `ready_to_proceed`, the read-only nature of a conversation, and the turn budget; prompt test asserting the contract
- [x] 5.2 API: `GET /api/goals/:id/input-request` returns the thread; respond endpoint accepts `proceed` and returns `conversation_continued`/`resumed`/`abandoned`; route tests for each outcome and the read-only rejection surfacing

## 6. Dashboard

- [x] 6.1 Render the input request as a thread (supervisor/caller messages) with a persistent reply box while `phase !== resolved`
- [x] 6.2 Affordances by reason: confirm/revise + proceed + abandon for `plan_confirmation`, reply + proceed + abandon for `supervisor_question`; component tests following the existing rendering test
- [x] 6.3 `waiting_user` badge already exists — verify the thread panel replaces the single-summary panel without regressing budget-escalation rendering

## 7. Verification and archive

- [ ] 7.1 `npm test` and `npm run typecheck` green
- [ ] 7.2 Live smoke: a `required`-policy goal whose supervisor's first delegation is rejected → it emits `propose_plan` → caller replies twice (multi-turn) → supervisor `ready_to_proceed` → work proceeds; then a work block in a conversational turn is shown rejected read-only; record evidence in `verification.md`
- [ ] 7.3 Update README escalation section; commit per task group throughout
