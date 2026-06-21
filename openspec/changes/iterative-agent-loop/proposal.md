## Why

The runtime today is single-shot: starting a goal calls the provider once, records one `agent.message`, and marks the goal completed. That cannot fulfil the product vision — a user opens a goal and an agent iteratively decomposes and works it step by step until done. This change introduces the spine of that vision: a bounded plan → implement → observe loop, with a planner that decides how to proceed and a completion gate decided by a majority vote across decorrelated providers rather than a single brittle judgment.

## What Changes

- Replace the single provider-backed smoke step with a bounded iterative loop that decomposes a goal and advances it across multiple durable steps.
- **Planner role** (single provider, generative): each iteration reads the run's persisted step history as context (app-level memory, no provider session) and emits the next step plus one graduated decision from a closed set — `IMPLEMENT_DIRECTLY`, `DECOMPOSE`, `NEEDS_OPENSPEC`, or `BLOCKED` — with reasoning.
- **Implementer role** (text-only for this MVP): for an `IMPLEMENT_DIRECTLY` step, produces a result describing what was done. It does not touch files or run commands yet.
- **Completion gate by quorum vote**: a binary proposition ("does the current result satisfy the goal/step acceptance criteria?") is decided by a 3-voter majority. Voters are preferably three different providers (codex-local / claude-local / openai-compatible) for decorrelation. A voter that errors or times out abstains; abstention is treated as the safe side ("not done, continue"). Only the gate votes; generation never votes.
- **Guardrails**: `maxSteps` and `maxDepth` bounds force termination. The agent's decisions are advisory; the loop enforces the bounds so it cannot loop forever or burn unbounded tokens.
- **Durable observability**: every iteration persists run/step/event records that distinguish the planner decision, the implementer result, and the gate outcome (each individual vote plus the final majority).

## Capabilities

### New Capabilities
- `iterative-agent-loop`: a bounded plan→implement→observe runtime loop with a graduated planner decision set, a decorrelated quorum completion gate, termination guardrails, and durable per-iteration events.

### Modified Capabilities
<!-- none; existing model-provider-integration and persistence are reused unchanged -->

## Impact

- Runtime: new loop orchestrator alongside `src/runtime/provider-runtime.ts` (planner/implementer roles via prompt over the existing `ModelProvider.complete()`; a quorum gate that fans out to multiple providers). New decision/vote types.
- Domain: likely new `EventType` values (e.g. `agent.decision`, `gate.voted`) added to the union (stored as TEXT, no schema migration); a closed `PlannerDecision` type.
- Backend: goal start invokes the loop runtime; the loop selects the configured provider for planning/implementing and a voter set for the gate.
- Mock provider: must drive a deterministic multi-step loop that terminates, and supply deterministic voters, so the loop and quorum logic are testable without real models.
- Non-goals (deferred): implementer actually editing files / running commands (CLI agent tool mode); the agent literally driving the openspec-propose/apply skills (here `NEEDS_OPENSPEC`/`DECOMPOSE` only record the decision and inline sub-steps); live UI streaming (SSE); provider session continuation (`conversationState`/`--resume`). Existing Codex/Claude/mock behavior and settings are unchanged.
