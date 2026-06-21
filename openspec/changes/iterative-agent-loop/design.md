## Context

The runtime is single-shot: `createProviderRuntime(...).run(goalId)` calls `provider.complete()` once, writes one `agent.message`, and marks the goal completed (`src/runtime/provider-runtime.ts`). The product vision needs the opposite shape — a goal that an agent decomposes and advances across many steps until it is judged done. The persistence model (runs, steps, events) already supports multiple steps and a rich event timeline, and the provider boundary (`ModelProvider.complete()`, four implementations) is stable. This change builds the loop on top of those without changing them.

Two design decisions were settled with the user before this proposal:
- The planner's "how to proceed" judgment is a closed graduated set (`IMPLEMENT_DIRECTLY` / `DECOMPOSE` / `NEEDS_OPENSPEC` / `BLOCKED`), not a binary done/continue sentinel — room within structure.
- The "is it done" judgment is made by a decorrelated quorum vote (three providers, majority), not a single brittle agent call. Voting governs the binary gate; generation is never voted.

## Goals / Non-Goals

**Goals:**
- A bounded plan→implement→observe loop that advances a goal across durable steps and terminates predictably.
- Planner role emitting a closed graduated decision + next step + reason, with memory sourced from persisted steps (no provider session).
- Text-only implementer for `IMPLEMENT_DIRECTLY`.
- A completion gate decided by a 3-voter majority over decorrelated providers; abstain = safe side (not done).
- `maxSteps` / `maxDepth` guardrails that override planner advice.
- Deterministic loop + voters under the mock provider for tests.

**Non-Goals:**
- Implementer editing files / running commands (CLI agent tool mode).
- Agent literally driving the openspec skills (`NEEDS_OPENSPEC` / `DECOMPOSE` only record the decision and inline sub-steps here).
- Live UI streaming (SSE) and provider session continuation.
- Changing Codex/Claude/mock behavior, settings, or the `ModelProvider` contract.

## Decisions

### Decision: Loop orchestrator over the existing provider contract
Add an iterative loop runtime (e.g. `src/runtime/agent-loop-runtime.ts`) that drives the existing `ModelProvider.complete()` with two prompt roles (planner, implementer). It does not replace `provider-runtime.ts`; the backend selects the loop runtime for goal execution. Each iteration is a durable step with events.

- **Why**: reuses the stable provider boundary and persistence; the roles are prompts, not new infrastructure. Keeps the single-provider, two-role MVP small.
- **Alternative considered**: two separate agent subsystems (distinct planner/implementer providers). Deferred — same provider with two prompts is behaviorally sufficient for the MVP; split later when the implementer does real work or when planner/implementer want different models.

### Decision: Planner output is a parseable closed decision + free reason
The planner returns a structured decision the loop can dispatch on: one of the four enum values, the next step text (or sub-steps for `DECOMPOSE`), and a free-form reason. Parsing convention (e.g. a sentinel first line `DECISION: <value>` then body) is defined so free-text models can comply and the loop stays deterministic-enough to test.

- **Why**: gives graduated room without losing dispatchability/testability. The reason is advisory context; the enum drives control flow.
- **Risk** [free-text model ignores the convention] → on unparseable output, default to the safe interpretation (`BLOCKED` or "continue under bounds") and record the raw output for debugging.

### Decision: Quorum gate, decorrelated voters, abstain = not done
The completion gate asks each voter the same crisp binary proposition tied to acceptance criteria and takes the majority of three. Voters are resolved preferring three different providers (codex-local / claude-local / openai-compatible); when fewer than three are available, fall back to the configured provider with decorrelating prompt personas. Voter error/timeout = abstain = counted as "not done". Each vote and the final tally are persisted.

- **Why decorrelation matters**: three identical voters share failure modes and give false confidence; heterogeneity is what makes the vote informative. The multi-provider stack already built makes a heterogeneous pool nearly free.
- **Why abstain = not done**: the safe side is to keep working rather than declare a goal done on thin evidence.
- **Risk** [3× cost/latency per gate] → only the gate votes (not every step) and the gate runs once per iteration at most; voter calls can run in parallel.

### Decision: Guardrails are authoritative over agent judgment
`maxSteps` (total iterations) and `maxDepth` (decomposition nesting) are enforced by the loop irrespective of planner decisions. Reaching a bound terminates with a recorded terminal state.

- **Why**: "let the agent judge" without hard bounds risks non-termination and runaway token spend. Judgment is advisory; bounds are law.

### Decision: New event types for decision and vote, reusing the timeline
Add `agent.decision` (planner decision) and `gate.voted` (quorum result with per-vote data) to the `EventType` union. Event `type` is stored as TEXT, so no schema migration. Implementer results continue as `agent.message` with a role marker in `data`.

- **Alternative considered**: encode everything in `agent.message` data. Rejected — distinct event types make the timeline and future UI legible.

## Risks / Trade-offs

- [Planner output parsing is the fragile seam] → Define a strict, simple convention; default unparseable output to a safe terminal/continue path; record raw output. Cover with mock tests.
- [Quorum theater if voters correlate] → Enforce decorrelation by preferring distinct providers; document persona-based fallback when only one provider exists.
- [Cost/latency from voting and multi-step loops] → Bound with `maxSteps`; vote only at the gate; parallelize voter calls; keep the implementer text-only for now.
- [Non-termination] → Authoritative `maxSteps`/`maxDepth` bounds independent of agent decisions.
- [Determinism for tests] → Mock provider drives a fixed-length terminating loop and deterministic voters; assert recorded decisions, votes, and terminal state.

## Migration Plan

1. Add the loop domain types (`PlannerDecision`, vote/gate types) and new `EventType` values.
2. Implement the planner/implementer prompt roles over `ModelProvider.complete()` and a deterministic mock path.
3. Implement the quorum gate (voter resolution, parallel calls, abstain policy, tally) with deterministic mock voters.
4. Implement the loop orchestrator with `maxSteps`/`maxDepth` and durable per-iteration events.
5. Wire goal start to the loop runtime; keep the single-shot path available behind configuration if needed for comparison.
6. Tests: deterministic mock loop termination, planner decision dispatch, gate majority/abstention, guardrail enforcement, event shape.

Rollback: revert the change; the single-shot runtime path returns. No persistence schema change (new event types are TEXT values).

## Open Questions

- Exact persona-based fallback prompts when fewer than three providers are configured — deferred to implementation; the spec only requires decorrelation "preferring" three providers.
- Whether `NEEDS_OPENSPEC` should later actually drive the openspec skills (it only records the decision here) — deferred to the real-implementer change.
