## 1. Shared safety-net helper (TDD)

- [ ] 1.1 Write a failing test for `recordUnhandledRuntimeFailure`: given a goal in a non-terminal status and an error, it persists a durable `error` event and transitions the goal to `failed`.
- [ ] 1.2 Write a failing test: given a goal already in a terminal status (`completed`/`failed`/`blocked`), the helper records no event and does not change status (idempotent guard).
- [ ] 1.3 Write a failing test: the helper never throws even if an inner write fails (defensive wrapping).
- [ ] 1.4 Implement `recordUnhandledRuntimeFailure` to pass 1.1–1.3, reusing the existing `events` table / `error` type and the existing output sanitizer for the message.

## 2. Goal-start background-run boundary

- [ ] 2.1 Write a failing test at the start-route (or runtime.run wrapper) level: when the background run rejects and the goal is still `running`, a durable goal failure event is persisted and the goal becomes `failed`.
- [ ] 2.2 Replace the `console.error`-only `.catch` in `src/backend/routes/goals.ts` with a call to `recordUnhandledRuntimeFailure` (goal-scoped), keeping the immediate `res.json(started)` response behavior unchanged.
- [ ] 2.3 Confirm (test) the success path is untouched: a normally-completing run records no extra failure event.

## 3. Child event-consumption boundary

- [ ] 3.1 Write a failing test in `delegation-coordinator` scope: when `consumeChildEvents` rejects, a durable `error` event identifying the delegation request id and child session id is persisted, and the child session becomes `failed` only if not already terminal.
- [ ] 3.2 Write a failing test: a normal terminal child outcome (completed/failed/cancelled/timed_out/detached) produces no additional safety-net event and leaves the recorded outcome unchanged.
- [ ] 3.3 Wrap the `void consumeChildEvents(...)` launch so its rejection routes into the delegation-scoped safety net (attach a `.catch`, or make the launcher await-and-catch internally), without changing the fire-and-forget scheduling semantics.

## 4. Verify and commit

- [ ] 4.1 Run focused tests for the new files (`node --import tsx --test <files>`); all green.
- [ ] 4.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [ ] 4.3 Live smoke per CLAUDE.md: start the API on a test port, create + start a goal whose run is forced to throw at each boundary (or use an injected fault), and confirm via `GET /api/goals/:id/events` that a durable failure event appears and the goal status is `failed`. Record findings in this change's `verification.md`.
- [ ] 4.4 Commit the task group with an imperative message naming the change (`make-async-runtime-failures-durable`).
