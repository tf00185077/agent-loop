# Reproduction evidence

Run: 2026-07-17, master `37f3e08`, Windows, Node test runner.

Method: the three tests in `repro-tests.ts` assert the **desired** behavior this
change specifies. They were appended to
`src/runtime/agent-session/agent-session-manager.test.ts` (they reuse its local
fixtures: `createManagerFixture`, `scriptedEpochAdapter`, `specFlow`,
`runScript`, `recordingOpenSpecService`, `createHandle`, `changePlanEvent`,
`waitFor`) and run with:

```
node --import tsx --test --test-name-pattern="REPRO-H" src/runtime/agent-session/agent-session-manager.test.ts
```

Result: 3/3 failed, each on the intended assertion (verbatim):

```
✖ REPRO-H4: a validated spec result requires a Supervisor review gate before review-merge
  AssertionError [ERR_ASSERTION]: backend must request a Supervisor semantic review after a structurally valid spec result

✖ REPRO-H5: spec retry-budget exhaustion blocks the change but keeps the goal alive
  AssertionError [ERR_ASSERTION]: one change spec-budget exhaustion must not terminally block the whole goal

✖ REPRO-H6: reworded but semantically identical repeated gaps must still trip the circuit breaker
  AssertionError [ERR_ASSERTION]: a non-converging macro loop must trip the breaker even when the gaps are reworded
```

What each failure demonstrates on master:

- **H4**: no `change.spec_review_requested` event is ever emitted; the spec flow
  runs validation → review-merge → `change.spec_approved` with no semantic
  review by anyone (`approveSpecChangeAfterMerge`).
- **H5**: after two structural-validation rejections the third spec delegation
  triggers `blockChangeAndGoal`; a `goal.blocked` event exists and the goal
  status is terminally `blocked`.
- **H6**: the second unsatisfied reassessment reworded the same gap
  ("End-to-end verification is missing." → "There is still no end-to-end
  verification coverage."); `reassessmentGapSignature` (normalized prose
  equality) did not match, no `supervisor.reassessment_circuit_breaker` event
  was emitted, and a third epoch was armed instead.

Note for implementation: H6's test must be adapted to the structured-gap
schema (same `refs`, different `summary` wording) when the new
`managed_goal.reassessment` validation lands; H4/H5 apply as written. The
repro file is not part of the test suite on purpose — move its tests into the
manager test file (adapted) during implementation.
