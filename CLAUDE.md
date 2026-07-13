# CLAUDE.md

auto-agent: a goal-driven agent dashboard and runtime. A user states one large
goal; a managed supervisor (real provider: Codex/Claude CLI) decomposes it,
delegates tasks to child agents in isolated worktrees under frozen acceptance
contracts, and iterates until an explicit completion signal. Read
[README.md](README.md) for the product flow and current capabilities.

## How work happens here (non-negotiable workflow)

1. **Everything goes through OpenSpec.** Run `openspec list` to see active
   changes. New work starts as a proposal (`/opsx:propose`), implementation
   follows the change's `tasks.md` (`/opsx:apply <change>`), completed changes
   get their delta specs synced into `openspec/specs/` and are archived.
   `openspec/specs/` is the product truth; `openspec/changes/archive/*/
   verification.md` files hold live-run evidence for shipped changes.
2. **Commit at the end of every task group** (user requirement). Message style:
   imperative summary + short body naming the group and change.
3. **TDD**: write the failing test first, then implement. Run focused tests
   with `node --import tsx --test <file>`; full suite `npm test`; `npm run
   typecheck` must stay clean. All green before every commit.
4. **Verify nontrivial changes end to end** with a live smoke: start the API
   (`$env:PORT=34xx; npm run dev:api`), create + start a goal via
   `POST /api/goals` / `POST /api/goals/:id/start`, and read the durable event
   timeline (`GET /api/goals/:id/events`) as evidence. Record findings in the
   change's `verification.md`. Prune leftover `..\auto-agent-worktrees\*` git
   worktrees afterwards.

## Architecture rules that must not regress

- **The backend owns all side effects.** Agents emit fenced
  ` ```auto-agent-control ` JSON blocks (see `supervisor-prompt.ts`); the
  session manager validates and executes. Control blocks never select
  providers, never bypass validators.
- **Prompt text is not enforcement.** Every deterministic rule (acceptance
  contracts, retry budgets, sequencing, provider choice) lives in backend
  validators; prompts merely inform. This is the project's core lesson —
  do not add a rule as prompt-only.
- **Durable events are the source of truth.** Every meaningful transition is
  persisted to SQLite before anything streams; in-memory registries
  (task/change/role caches in `agent-session-manager.ts`) are working state
  only and may reset on restart.
- **Degrade visibly, never silently**: missing CLIs and unsupported
  capabilities produce durable `*.downgraded` / `*_unavailable` events and a
  fallback path, not failures.
- **Credential safety**: no tokens/keys in settings, events, or API responses;
  sanitize all provider output before persisting.

## Key code map

- `src/runtime/agent-session/` — control plane: `agent-session-manager.ts`
  (supervisor lifecycle, control-event routing, enforcement),
  `delegation-coordinator.ts` (child spawn/outcome mechanics),
  `task-registry.ts` + `change-registry.ts` (pure state machines),
  `delegation-control-event.ts` (control-block validation),
  `supervisor-prompt.ts` (prompt contracts), `openspec-workspace-service.ts`
  (backend-run OpenSpec scaffold/validate/archive).
- `src/runtime/providers/{codex,claude}/` — runtime adapters (control-block
  extraction lives in the adapters; parsing stays provider-pure).
- `src/backend/app.ts` — runtime selection; `role-adapter-resolver.ts` —
  user-configured role→agent assignments.
- Tests sit next to sources; the manager test file's mock-adapter fixtures
  (`createHandle`, one-shot supervisor branches) are the pattern for new
  control-plane tests.

## Environment notes

- Windows; PowerShell is the shell. Node >= 20.19. `codex` and `claude` CLIs
  must be logged in for live smokes; saved command paths self-heal via
  detection when machines change.
- `data/auto-agent.sqlite` is committed on purpose (dev state, credential-free).
