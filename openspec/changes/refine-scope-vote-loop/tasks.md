## 1. Domain Contracts

- [x] 1.1 Add explicit scope assessment and binary scope vote domain types.
- [x] 1.2 Add or rename event typing so scope voting is distinct from completion review voting.
- [x] 1.3 Update domain type tests and exports for the new contracts.

## 2. Planner Context

- [x] 2.1 Extend planner input and prompt construction to include bounded prior scope refinement context.
- [x] 2.2 Parse or map planner output so too-large assessments drive refinement and too-small assessments proceed to implementation.
- [x] 2.3 Add planner tests for scope assessment output and reason propagation.

## 3. Scope Vote Runtime

- [x] 3.1 Replace completion-gate quorum semantics with binary scope vote semantics.
- [x] 3.2 Record scope vote event data with true/false majority, voter reasons, and the proposition.
- [x] 3.3 Add voter tests for majority true, majority false, and voter failure behavior without abstain decisions.

## 4. Agent Loop Behavior

- [x] 4.1 Remove post-implementation voting from `IMPLEMENT_DIRECTLY` and close the current work item after marking the step completed.
- [x] 4.2 Add separate `maxScopeAssessmentAttempts` and `maxScopeRefinementRounds` loop bounds.
- [x] 4.3 Carry the latest planner and voter reasons into the next refinement round.
- [x] 4.4 Proceed directly to implementation when a binary scope vote returns false.
- [x] 4.5 Block only when the planner returns blocked or scope refinement rounds are exhausted.

## 5. Mock Runtime And API Wiring

- [x] 5.1 Update mock runtime defaults and deterministic planner/voter behavior for scope refinement.
- [x] 5.2 Wire the new loop-bound options through backend runtime creation without changing dashboard credentials or provider boundaries.
- [x] 5.3 Update backend API tests that inspect loop bounds and vote events.

## 6. Verification

- [x] 6.1 Run focused domain, voter, planner, runtime, mock runtime, and backend API tests.
- [ ] 6.2 Run typecheck and the full test suite, documenting any pre-existing unrelated failures.
- [ ] 6.3 Run browser verification against the local dashboard using the Codex model path and confirm the provider setup still renders.
- [ ] 6.4 Run `openspec validate refine-scope-vote-loop --strict`.
