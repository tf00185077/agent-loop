# Project Context

## Project

auto-agent is a goal-driven agent dashboard and runtime. The product centers on goals: a user creates a goal, the backend persists it, an agent run works toward completion, and the dashboard shows durable progress through runs, steps, and events.

The current repository is in the architecture cleanup / foundation stage. It contains project documentation and strict TypeScript domain types, but not the backend API, SQLite store, runtime loop, provider adapter, tests, or React dashboard yet.

## Source Of Truth

- `README.md` describes the current project status and intended product flow.
- `ARCHITECTURE.md` describes the MVP architecture, domain model, API shape, persistence strategy, runtime constraints, provider boundary, implementation order, and non-goals.
- `src/domain` contains the current framework-agnostic TypeScript domain contracts.

## Target MVP Stack

- TypeScript on Node.js 20.19+.
- React/Vite dashboard.
- Express backend REST API.
- SQLite state store, defaulting to a local path such as `data/auto-agent.sqlite`.
- In-process single-agent runtime loop.
- Model provider adapter boundary, starting with a mock provider and an OpenAI-compatible provider option.

## Current Tech Conventions

- Use strict TypeScript.
- Use ES2022 and NodeNext module resolution.
- Use `.js` extensions in relative TypeScript imports for NodeNext compatibility.
- Keep domain types under `src/domain`.
- Re-export public domain types from `src/domain/index.ts`.
- Prefer explicit interfaces for persisted entities and input DTOs.
- Prefer string literal union types for statuses and lifecycle values.
- Keep shared domain contracts framework-agnostic.

## Domain Vocabulary

- Goal: the top-level user intent.
- Run: one execution attempt for a goal.
- Step: an ordered unit of work inside a run.
- Event: a durable timeline item shown in the dashboard for observability.

Goal statuses are `draft`, `running`, `waiting_user`, `blocked`, `completed`, `failed`, and `cancelled`.

Run statuses are `queued`, `running`, `completed`, `failed`, and `cancelled`.

Step statuses are `pending`, `running`, `completed`, `failed`, and `skipped`.

Core event types include `goal.created`, `run.started`, `step.started`, `agent.message`, `step.completed`, `run.completed`, `goal.completed`, `goal.blocked`, and `error`.

## Architecture Rules

- The primary product flow is goal-centric, not chat-centric.
- Chat-like messages may exist as run events, but should not become the main architecture.
- The dashboard must not store provider credentials or call model providers directly.
- The dashboard should communicate with the backend through REST API calls.
- SQLite should be the durable system of record for goals, runs, steps, and events.
- In-memory runtime state is allowed only as a short-lived execution detail.
- The runtime should write durable events before and after meaningful actions.
- The provider adapter should isolate runtime code from any single model provider.
- Optimize for a working local single-user MVP before designing distributed or multi-user features.

## MVP Non-Goals

- Multi-user authentication.
- Distributed workers or queue systems.
- Multi-agent orchestration.
- Complex permission policy.
- Full artifact management.
- Notifications.
- Billing or token-cost accounting.
- Complete Git workflow automation.

## OpenSpec Guidance

When creating OpenSpec changes:

- Keep proposals aligned with `README.md` and `ARCHITECTURE.md`.
- Include clear non-goals when a feature touches future roadmap territory.
- Design around durable goal, run, step, and event state.
- Break tasks into verifiable slices with tests for the affected layer.
- Prefer mock-provider-first runtime work so behavior is testable without live credentials.
