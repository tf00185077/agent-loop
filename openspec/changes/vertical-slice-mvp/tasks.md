## 1. Project Foundation

- [x] 1.1 Add development scripts for typecheck, tests, backend dev server, dashboard dev server, and full local development.
- [x] 1.2 Add the initial test framework and one smoke test so verification commands have a baseline.
- [x] 1.3 Create backend, persistence, runtime, and dashboard folder boundaries that keep shared domain types framework-agnostic.

## 2. SQLite State Store

- [x] 2.1 Add SQLite dependency and database connection configuration with a local default path.
- [x] 2.2 Create schema initialization for goals, runs, steps, and events.
- [x] 2.3 Implement goal repository functions for create, list, get by id, and lifecycle status updates.
- [ ] 2.4 Implement run, step, and event repository functions needed by the mock runtime lifecycle.
- [ ] 2.5 Add persistence tests proving created goals and events survive database reopen.

## 3. Backend API

- [ ] 3.1 Add Express backend bootstrap with JSON parsing, error handling, and health check.
- [ ] 3.2 Implement `POST /api/goals` with input validation and `goal.created` event persistence.
- [ ] 3.3 Implement `GET /api/goals` for the dashboard goal list.
- [ ] 3.4 Implement `GET /api/goals/:id` for the dashboard goal detail snapshot.
- [ ] 3.5 Implement `GET /api/goals/:id/events` for the durable timeline.
- [ ] 3.6 Implement `POST /api/goals/:id/start` as the only MVP runtime action endpoint.
- [ ] 3.7 Add API tests covering create, list, detail, start, and events without using run or step query endpoints.

## 4. Mock Runtime

- [ ] 4.1 Implement an in-process mock runtime service that starts from a persisted draft goal.
- [ ] 4.2 On start, create a run, mark the goal running, and record a `run.started` event.
- [ ] 4.3 Create and complete mock steps while recording `step.started`, `agent.message`, and `step.completed` events.
- [ ] 4.4 Complete the happy path by marking the run and goal completed and recording `run.completed` and `goal.completed` events.
- [ ] 4.5 Add a deterministic blocked path that marks the goal blocked and records `goal.blocked`.
- [ ] 4.6 Add runtime tests proving the event timeline is sufficient to understand lifecycle progress.

## 5. Thin Dashboard

- [ ] 5.1 Add React/Vite dashboard scaffold wired to the backend API.
- [ ] 5.2 Implement goal list view using `GET /api/goals`.
- [ ] 5.3 Implement create goal form using `POST /api/goals`.
- [ ] 5.4 Implement goal detail view using `GET /api/goals/:id`.
- [ ] 5.5 Implement start button using `POST /api/goals/:id/start`.
- [ ] 5.6 Implement event timeline using `GET /api/goals/:id/events`.
- [ ] 5.7 Verify the dashboard demo path works after browser refresh without dedicated run or step query APIs.

## 6. MVP Validation And Documentation

- [ ] 6.1 Add an end-to-end or integration verification for create goal, start goal, and read event timeline.
- [ ] 6.2 Update README with local setup, run commands, and the MVP demo path.
- [ ] 6.3 Run typecheck, tests, and OpenSpec validation for `vertical-slice-mvp`.
- [ ] 6.4 Review the implementation against proposal non-goals and remove any accidental scope creep.
