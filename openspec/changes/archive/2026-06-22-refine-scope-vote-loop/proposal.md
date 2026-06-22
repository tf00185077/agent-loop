## Why

The iterative agent loop currently treats post-implementation voting as the completion gate, but implementation work should be able to finish its assigned task without requiring quorum approval. Scope control is still needed when the planner repeatedly decides a task is too broad, so voting should move to a dedicated scope-refinement gate.

## What Changes

- Remove quorum voting from the `IMPLEMENT_DIRECTLY` execution path.
- Add an explicit scope-assessment path for planner decisions that consider the current task too large.
- Add a binary three-voter scope vote that only answers whether the current task still needs refinement.
- Carry the previous planner and voter reasons into the next refinement round to avoid repeating the same decomposition attempt.
- Split the loop bounds into planner assessment attempts and scope refinement rounds.
- Treat planner `BLOCKED` decisions, or exhausted refinement rounds, as the only blocked terminal paths for this behavior.
- Treat tasks that are ready or too small as directly implementable for this change.

## Capabilities

### New Capabilities

### Modified Capabilities
- `mock-agent-runtime`: Changes the iterative mock runtime requirements for implementation completion, scope refinement voting, bounded decomposition, and blocked terminal behavior.

## Impact

- Affects runtime planner decision handling, quorum vote domain types, runtime event data, and tests around iterative loop behavior.
- Updates mock runtime behavior used by local development and browser verification.
- Does not add distributed workers, multi-agent orchestration, human review gates, or persistent DB-backed task assignment beyond the existing step/status interfaces.
