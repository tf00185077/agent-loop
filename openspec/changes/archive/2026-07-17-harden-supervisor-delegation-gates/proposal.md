# Harden Supervisor Delegation Gates

## Why

Three reproduced defects let the managed supervisor loop ship bad outcomes or kill goals it should recover: (1) a structurally valid spec advances to execution with **no semantic review by anyone** — format-valid-but-wrong specs go straight to `executing`; (2) one change's spec retry-budget exhaustion terminally blocks the **whole goal**, even though the multi-epoch loop exists precisely to re-plan around failed scope; (3) the reassessment circuit breaker compares **normalized prose**, so an LLM's natural paraphrasing of the same unresolved gap bypasses it every time, leaving only the epoch budget to stop a non-converging macro loop.

All three are demonstrated by failing desired-behavior tests recorded in this change's `repro/` directory (run against master `37f3e08`).

## What Changes

- Insert a deterministic Supervisor semantic-review gate between spec structural validation and review-merge: the backend requests a review with a bounded artifact packet, records one durable approve/reject decision per validated worker attempt, and rejects review-merge for unapproved attempts. Rejection feedback is delivered verbatim to the corrective spec attempt. (The `codex/supervisor-spec-approval` branch is the reference implementation; its two known defects — an unguarded durable transition on reject and exact-text duplicate-decision matching — are corrected by requirements here.)
- Spec retry-budget exhaustion durably blocks the **change** and keeps the goal `running`; the reassessment timing gate treats blocked changes as terminal so the supervisor can re-plan the blocked scope in a next epoch. The goal only terminates through the existing macro-loop bounds (epoch budget, circuit breaker) or explicit completion.
- **BREAKING** (control-block schema): `managed_goal.reassessment` remaining gaps become structured objects carrying durable artifact references (`refs`) plus a prose summary; refs are validated against durable state, and the repeated-gap circuit breaker keys on the ref-set, not prose. Plain-string gaps are rejected with a safe reason teaching the structured form.

## Capabilities

### New Capabilities
- `supervisor-spec-approval`: the Supervisor's stateful, backend-enforced semantic review of validated spec artifacts — review request packets, one durable decision per attempt, approval-gated review-merge, attempt-scoped approval invalidation, and restart rehydration.

### Modified Capabilities
- `goal-scale-decomposition`: "Contracted spec authoring" gains the semantic-review gate before review-merge; spec budget exhaustion changes from goal-terminal to change-blocking with a durable re-planning path.
- `multi-epoch-planning`: "Goal reassessment control block" requires structured remaining gaps with validated refs; "Bounded macro loop" keys the repeated-gap breaker on ref-set identity; "Reassessment timing gate" admits reassessment when every change is archived **or blocked**.

## Impact

- `src/runtime/agent-session/agent-session-manager.ts` — spec review routing, budget-exhaustion path (`blockChangeAndGoal` split into change-block vs goal-block), reassessment validation and breaker signature.
- `src/runtime/agent-session/change-registry.ts` — spec review state machine, blocked-change semantics in the reassessment gate.
- `src/runtime/agent-session/delegation-control-event.ts` — `managed_change.spec_review` validation; structured `remainingGaps` validation.
- `src/runtime/agent-session/supervisor-prompt.ts` — prompt contract additions (informational only; every rule is backend-enforced).
- `src/runtime/agent-session/supervisor-state-rehydration.ts` — replay of spec-review and blocked-change state.
- Dashboard event timeline gains new durable event types (`change.spec_review_requested`, `change.spec_supervisor_approved/rejected`, `change.spec_merged`); no API surface changes.
- Migration note: dev-only SQLite; in-flight goals created before this change are not preserved across the `change.spec_approved` → `change.spec_merged` event rename or the reassessment schema change.

## Non-Goals

- No human-in-the-loop spec approval UI (the Supervisor agent decides; the dashboard only observes).
- No fuzzy/semantic text matching anywhere — gap identity is exact ref-set equality; prose is never enforcement input.
- No change to the flat (non-planned) goal flow, worker acceptance contracts, or delivery/integration machinery.
- No multi-user or distributed concerns.
