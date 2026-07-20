# Tasks — supervisor-request-input

## 1. Domain and grant allowlist

- [x] 1.1 Add `supervisor_question` to `GoalInputRequestReason`; make `payload.budgetName`/`budgetValue` nullable; `allowedDecisionsForReason` returns `provide_guidance`+`abandon` for questions; add `managed_goal.request_input` to the control-event type union (TDD: type/contract tests first)
- [x] 1.2 Failing test + fix: `sumAcceptedExtensions` implicit +1 applies only to `epoch_budget_exhausted` and `continuation_exhausted` (accepted question guidance grants nothing)

## 2. Control-block validation

- [ ] 2.1 Failing tests in `delegation-control-event.test.ts`: well-formed question accepted; empty question, oversized question (>2000), >5 context strings, oversized context string (>500) rejected with safe reasons naming the bounds
- [ ] 2.2 Implement `managed_goal.request_input` shape validation in `delegation-control-event.ts` (pure; trims and bounds text)

## 3. Manager acceptance gates and escalation

- [ ] 3.1 Failing tests (new theme file or `agent-session-escalation.test.ts`): valid question → `supervisor_question` pending request with null budget fields, `waiting_user`, `goal.input_requested` event with `runtimeEventType: "supervisor.question"`, no continuation after session exit
- [ ] 3.2 Failing tests: rejections — pending request already exists; in-flight delegation (requested/accepted/running); question budget exhausted (default 3, counted from durable rows, restart-safe) with autonomy-teaching safe reason; each via `recordControlRejection`
- [ ] 3.3 Implement the handler branch + `maxSupervisorQuestions` deps option; reuse `escalateGoalForCallerInput` with nullable budget fields
- [ ] 3.4 Failing test + implementation: respond flow handles null budgets (no effective-budget math in the accepted event); answer resume observation renders `Q: … A: …`; abandon on a question blocks the goal

## 4. Prompt contract and dashboard label

- [ ] 4.1 Document `managed_goal.request_input` in `supervisor-prompt.ts` (when to ask: only decisions the caller alone can make; question budget; end turn after asking); prompt test asserting the contract text
- [ ] 4.2 Dashboard: add the `supervisor_question` reason label; rendering test showing question summary + guidance/abandon only

## 5. Verification and archive

- [ ] 5.1 `npm test` and `npm run typecheck` green
- [ ] 5.2 Live smoke: scripted supervisor emits a question mid-run → API shows the pending question → answer via `provide_guidance` → resumed continuation prompt contains Q and A → second question after budget exhaustion is rejected with the autonomy reason; record evidence in `verification.md`
- [ ] 5.3 Update README escalation section; commit per task group throughout
