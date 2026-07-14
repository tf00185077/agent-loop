# Verification — make-async-runtime-failures-durable

## Automated tests

- `src/runtime/agent-session/unhandled-failure.test.ts` (helper unit tests) — 10/10 pass.
  Covers: goal non-terminal → durable `error` event + goal `failed`; idempotent
  no-op when goal already `completed`/`failed`/`blocked`/`cancelled`; helper never
  throws when the durable write itself fails; delegation-scoped event carries the
  delegation request id + child session id; does not re-mark an already-terminal
  child session.
- `src/backend/routes/goals-failure.test.ts` (goal boundary, real HTTP + real
  SQLite) — 2/2 pass. A rejecting background `runtime.run` yields a durable
  `runtime.unhandled_failure` (scope `goal`) event and transitions the goal to
  `failed`; the success path records no failure event.
- `src/runtime/agent-session/delegation-coordinator-failure.test.ts` (delegation
  boundary, real coordinator + real SQLite) — 2/2 pass. A rejecting
  `onChildOutcome` yields a durable `runtime.unhandled_failure` (scope
  `delegation`) event identifying the delegation request + child session; a
  normal child outcome records no safety-net event.
- `npm run typecheck` — clean.
- `npm test` — 471 pass, 0 fail, 14 skipped (pre-existing skips).

## Live smoke (happy-path regression)

Booted the real API (`node --import tsx src/backend/server.ts`, `AUTO_AGENT_PROVIDER=mock`,
`PORT=3499`, scratch DB). Created and started a goal; the durable timeline flowed
normally through `goal.created … run.completed … goal.completed` and the goal
ended `completed` with no spurious failure event. This confirms the added
`.catch` wiring does not regress the success path.

## Note on the failure-path live surface

Inducing a genuine *unhandled* runtime rejection in a manually driven live server
requires fault injection. That path is instead proven at the live surface by the
two integration tests above, which drive the real Express goal route and the real
delegation coordinator against a real SQLite database with an injected rejection,
and assert the durable event + status transition. This is intentionally
visibility-only: a failed goal ends `failed`; recovery/continuation is out of
scope for this change (deferred to Phase 3).
