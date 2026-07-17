# Verification: multi-epoch-supervisor-loop

Date: 2026-07-16 (macOS dev machine, Node v22.22.2)

## Automated evidence

- `npm run typecheck` — clean.
- `npm test` — 543/543 pass (final run after all fixes).
- Focused suites (all green):
  - `delegation-control-event.test.ts` — `managed_goal.reassessment`
    validation (satisfied/unsatisfied shapes, evidence/gap/rationale rules)
    and the 1–8 plan budget.
  - `change-registry.test.ts` — epoch metadata, `recordReassessment` gates
    (plan exists + all archived), `registerNextEpoch` gates (pending
    unsatisfied reassessment, id uniqueness across epochs, gate consumption).
  - `agent-session-manager.test.ts` (49 tests) — end-to-end scripted flows on
    real SQLite:
    - change-lifecycle test now proves AC5: completion after all changes
      archived is REJECTED until a satisfied `managed_goal.reassessment` is
      recorded, then accepted; durable lifecycle order includes
      `supervisor.reassessment`.
    - "admits a next epoch after an unsatisfied reassessment…" proves
      AC2/AC3/AC8: epoch 1 archived → unsatisfied reassessment (durable
      event, `epochSequence: 1`) → second `managed_change.plan` accepted as
      epoch 2 with the reassessment's rationale, scaffolded and activated →
      satisfied reassessment → completion.
    - circuit-breaker test proves AC7: consecutive unsatisfied reassessments
      with the same normalized gap signature move the goal to `blocked` with
      a durable `supervisor.reassessment_circuit_breaker` event.
    - epoch-budget test proves AC7: `maxPlanningEpochs: 1` + unsatisfied
      reassessment → `blocked` with `supervisor.epoch_budget_exhausted`.
    - flat-goal and premature reassessments are rejected with safe reasons.
  - `supervisor-state-rehydration.test.ts` — AC6: chronological replay of
    plan → transitions → reassessment → next plan restores epoch count,
    rationales, change statuses, judgment history, and keeps the next-epoch
    gate closed.
  - `planning-epoch-projection.test.ts` — epoch/status/reassessment fold
    from durable events (executing / reassessing / gaps_found / completed /
    blocked).
  - `api.test.ts` (53 tests) — snapshot endpoint returns `planningEpochs`
    derived from durable events (AC8/AC4 projection).
  - `agent-session-controls-rendering.test.tsx` — GoalDetail epoch board
    renders sequences, statuses, rationale, change chips, and remaining gaps.

## Live smoke (API, mock provider)

- `PORT=3456 npx tsx src/backend/server.ts`, then:
  - `POST /api/goals` → goal `1b429832-50e9-43e2-9636-2659c9120c5b`
  - `POST /api/goals/:id/start` with `providerOverride: {provider: "mock"}`
  - Goal reached `completed`; durable timeline unchanged for flat goals
    (goal.created → run.started → steps → gate.voted done → run.completed →
    goal.completed) — AC1/no-regression for unplanned goals.
  - `GET /api/goals/:id/agent-session` → `planningEpochs: []` (present, empty
    for flat goals).

## Environment incident found and fixed during verification

The first full `api.test.ts` run corrupted `~/.nvm/versions/node/v22.22.2/
bin/node`: the fake-codex test fixture wrote its response to
`process.argv[indexOf("--output-last-message") + 1]`, which resolves to
`argv[0]` — the node executable — whenever the flag is absent. On the
case-insensitive macOS filesystem the corrupted `node` (shell-interpreted as
`Codex override response`) and the `codex` wrapper then formed a
self-sustaining process chain (~8.5k processes). Recovery: restored the
genuine binary from the nvm cache tarball, killed the chain, and fixed the
fixture in `api.test.ts` and `codex-cli-provider.test.ts` to guard the flag
lookup. A stale `node.corrupt-20260716` artifact shows the same corruption
had already happened on 2026-07-13, so this was a pre-existing hazard, not
one introduced by this change. After the fix, `api.test.ts` passes 53/53.

One additional pre-existing macOS portability failure was fixed in
`codex-runtime-adapter.test.ts` (child `process.cwd()` reports
`/private/var/...` while `mkdtemp` returns the `/var/...` symlink form); the
assertion now realpaths both sides.
