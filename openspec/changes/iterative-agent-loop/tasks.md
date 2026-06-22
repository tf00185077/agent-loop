## 1. Domain types and events

- [x] 1.1 Add a closed `PlannerDecision` type (`IMPLEMENT_DIRECTLY` | `DECOMPOSE` | `NEEDS_OPENSPEC` | `BLOCKED`) and planner/implementer result types
- [x] 1.2 Add a quorum vote type (per-voter ballot + tally) and add `agent.decision` and `gate.voted` to the `EventType` union; export through `src/domain/index.js`
- [x] 1.3 Add domain tests for the new types/enums

## 2. Planner and implementer roles

- [x] 2.1 Implement a planner that builds its prompt from the goal + persisted prior steps and parses the model output into `{ decision, nextStep | subSteps, reason }` with a strict convention
- [x] 2.2 Default unparseable planner output to a safe path (record raw output; treat as `BLOCKED` or continue-under-bounds) instead of crashing
- [x] 2.3 Implement a text-only implementer that returns a result for an `IMPLEMENT_DIRECTLY` step (no file/command side effects)
- [x] 2.4 Tests for planner parsing (each decision + malformed output) and implementer result

## 3. Quorum completion gate

- [x] 3.1 Implement voter resolution preferring three distinct providers (codex-local / claude-local / openai-compatible), with persona-based fallback when fewer are configured
- [x] 3.2 Run the three voters (in parallel) on the binary acceptance proposition; map error/timeout to abstain; tally majority with abstain counted as "not done"
- [x] 3.3 Return and record the per-voter ballots plus the final majority decision
- [x] 3.4 Tests: majority-done, majority-not-done, abstaining voter counts as not done, decorrelation (distinct voters used)

## 4. Loop orchestrator

- [x] 4.1 Implement the plan→implement→observe loop that, per iteration, runs the planner, dispatches on the decision, runs the implementer for direct steps, runs the gate, and persists a durable step + events (`agent.decision`, `agent.message`, `gate.voted`)
- [x] 4.2 Enforce `maxSteps` and `maxDepth` as authoritative bounds that terminate the loop regardless of planner decisions; record the terminal state (completed / blocked / bounded)
- [ ] 4.3 Source planner memory from persisted steps each iteration (no provider session)
- [ ] 4.4 Tests: multi-step advance, depth bound stops decomposition, step bound overrides planner, blocked terminal state

## 5. Mock determinism

- [ ] 5.1 Make the mock provider drive a deterministic, terminating multi-step loop (fixed plan → implement → done)
- [ ] 5.2 Provide deterministic mock voters so the gate outcome and recorded ballots are predictable
- [ ] 5.3 Tests asserting deterministic termination, recorded decisions, and recorded votes

## 6. Backend wiring

- [ ] 6.1 Wire goal start to the iterative loop runtime (configurable bounds; default provider for planner/implementer; voter set for the gate)
- [ ] 6.2 API test: start a goal under the mock loop and assert the event timeline shows multiple steps, planner decisions, implementer results, and a recorded gate vote ending in a terminal state

## 7. Verify

- [ ] 7.1 Run the full test suite and typecheck; confirm existing single-shot, Codex/Claude/mock paths are unaffected
- [ ] 7.2 Run `openspec validate iterative-agent-loop --strict` and confirm the change is clean
