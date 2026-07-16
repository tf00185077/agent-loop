# Crash-Durable Agent Loop — Diagnosis & Recovery Roadmap

Status: **living roadmap.** Phase 0 is proposed as an OpenSpec change
(`make-async-runtime-failures-durable`). Phases 1–4 are intentionally NOT yet
written as OpenSpec changes — each is opened just-in-time after the prior one
lands, so its spec reflects the real post-implementation code state instead of
stale assumptions.

## Motivation

auto-agent's stated product vision is a loop that runs "until the product is
deliverable." The current system models task **state** durably and well, but it
conflates two different properties:

- **Traceability** — after the fact, can we reconstruct *what happened and why*?
  Strong today (`events` + `managed_task_*` tables record every transition).
- **Reliability** — when the process crashes mid-run, can the system *continue
  correctly to the end*? Essentially absent today.

The root gap: **the durable state is a faithful history book, not a reloadable
execution snapshot.** The DB records what happened; it is not (yet) complete
enough to be re-read as the instruction set for resuming an interrupted run.

## Mental models (the reasoning tools)

### The kill test

> "If I `kill -9` the backend right now, what must it know on restart to
> *continue* correctly?"

Apply it at any instant. It forces separating two kinds of data:

- **History** — what already happened (durable today).
- **Intent / in-flight state** — what is *being attempted but not yet finished*
  (today held in memory: `SupervisorState` maps, live process handles).

On crash, history survives but intent evaporates, so the system can only fail
cleanly, never resume.

### Two classes of external side effect

A side effect touches a world outside the DB. There are two kinds, and their
recovery strategies are fundamentally different:

- **Reconcilable (git / filesystem)** — state persists across a crash; the DB
  can hold an idempotency key and *ask the ground truth* on recovery whether the
  effect landed. Fix = **write-ahead intent + reconcile**.
- **Unreattachable (OS process)** — a killed process holds nothing; its in-flight
  stdout/result stream is gone. The DB can never reconcile against a dead
  process. Fix = **idempotent re-run from a durable contract** (never reattach).

### The dual-write problem

Any single operation that mutates two stores that cannot be committed atomically
together (e.g. git commit + a SQLite row) has a crash gap where the two disagree.
Resolution is not atomicity (impossible) but **ordering**:

> Write durable intent (with a reconciliation key) to the ledger **before** the
> external side effect; write the outcome **after**; on recovery, resolve every
> "intent without outcome" by consulting the external ground truth — never by
> guessing. The DB owns *intent and state-machine phase*; git/OS own *whether the
> effect actually landed*.

### Floor vs quality layer for process work

- **Correctness floor (provider-agnostic, always works):** idempotent re-run of a
  task from its frozen acceptance contract + a clean checkpoint. Discard partial
  work.
- **Quality layer (provider-dependent, best-effort):** conversation *resume*
  (new process replaying the provider's persisted transcript). Requires durably
  persisting the provider session id. It restores *reasoning continuity*, not
  *state truth*, and cannot fix an inconsistent worktree or ledger by itself.

Cattle vs pets: **workers are cattle** — on crash, discard and re-run (their
mid-edit worktree is untrustworthy anyway, so resume buys nothing). **The
supervisor is the pet** worth recovering, because it holds whole-goal reasoning
context. But supervisor recovery must be a hybrid:

- **Always** project durable ledger state into its context (state truth /
  correctness floor). auto-agent already has this via
  `managed-context-projection` + continuation prompts.
- **Additionally** resume the conversation when the provider supports it
  (reasoning-quality bonus). Never let resumed memory override ledger state.

Consequence: because the durable projection can already reconstruct supervisor
context, the whole system can recover **without provider resume at all** — the
missing piece is a recovery routine that *uses* the projection to continue
instead of force-failing. Provider resume is pure gravy.

## Recoverable worker-delegation walkthrough

### Happy path — bracket each external side effect with intent

The delegation state machine (`requested → accepted → running → completed`)
already exists; what is missing is the "intent bracket" and the reconciliation
keys.

| Phase | Durable intent written BEFORE (with key) | External side effect | Written AFTER |
| --- | --- | --- | --- |
| create worktree | delegation `accepted`, task `delegated`, **target worktree path** | `git worktree add` | confirm `session.worktree` |
| spawn worker | delegation `running`, **provider session id** (new) | `adapter.startSession` spawn | — |
| worker reports | — | worker writes files → emits `managed_task.result` | attest file list → delegation `completed` (**trustworthy checkpoint**) |
| delivery | **delivery `pending` + candidate SHA + checkpoint HEAD** (new) | `cherry-pick` + fixed validation | delivery `committed` / reverted |

### Recovery — reconcile each world by phase (replace force-fail-all)

| Delegation phase at crash | Likely real disk/process state | Recovery action |
| --- | --- | --- |
| `accepted` (no worktree yet) | nothing external done | reset task to `registered`, re-dispatch |
| worktree created, before `running` | orphan worktree on disk; process maybe/maybe-not | clean worktree, reset task, re-dispatch |
| `running` (worker killed mid-edit) | worktree half-written & untrustworthy; process dead | discard worktree, mark attempt `interrupted` (durable), reset task, idempotent re-dispatch |
| `completed` (result consumed, attested) | worktree at a known-good attested point | re-verify attestation vs disk, proceed to review/delivery |
| delivery `pending` (new intent row) | git may/may-not hold the cherry-pick | ask git whether candidate SHA is in HEAD → mark `committed` or safely re-deliver |

## Dual-write hotspot sweep

Organized by substrate class. "Dormant" = currently masked by the force-fail-all
policy; becomes active the moment crash-recovery/continuation is added.

| # | Hotspot | Worlds touched | Crash gap | Class / confidence |
| --- | --- | --- | --- | --- |
| 1 | Delivery (`agent-session-manager.ts` ~1129) | git commit + DB delivery row | git has commit, DB has no row → future re-run double-commits / orphan commit | git · confirmed |
| 2 | Integration-recovery delivery (~1346) | git + DB | same as #1 | git · confirmed |
| 3 | Worker worktree (`delegation-coordinator.ts` ~312) | disk worktree + DB session | orphan worktree, no auto cleanup (manual prune today) | disk · confirmed |
| 4 | Worker child process (~207) | OS process + DB | process orphaned/killed, result stream permanently severed | process · confirmed (re-run only) |
| 5 | Supervisor process (`agent-session-manager.ts` ~141) | OS process + DB | same as #4; the goal's "brain" is severed | process · confirmed |
| 6 | review_merge checkpoint/apply (~295) | git (supervisor workspace) + DB review row | checkpoint/apply interrupted; workspace vs ledger disagree | git · high, re-verify |
| 7 | OpenSpec plan scaffold | disk artifacts + git commit + DB spec-task rows | files/commit/registration may be partial | git+disk · per README |
| 8 | Event → SSE (`goals.ts` ~200) | DB event + in-memory eventBus | events during disconnect are never replayed (no cursor) | memory · confirmed |

## Phased roadmap

Floor first, resume last. One OpenSpec change per phase; each independently
shippable, TDD'd, and committed per task group. Later phases are opened
just-in-time so their specs match reality.

### Phase 0 — Make async runtime failures durable  *(proposed)*
Closes the silent-failure holes: `runtime.run().catch(console.error)` and
`void consumeChildEvents`. Any unhandled async failure becomes a durable event +
status transition. **Visibility only, no recovery.** Fully decoupled from the
rest. → OpenSpec change `make-async-runtime-failures-durable`.

### Phase 1 — Write-ahead delivery + git reconciliation
Split `deliver()` so a delivery `pending` row (candidate SHA + checkpoint) is
written before the cherry-pick; add `reconcilePendingDelivery(candidateSha)` that
consults git. Same for the integration path. Fixes hotspots #1/#2.
Verify: crash between pending and outcome must not double-commit.

### Phase 2 — Reconcile orphaned worktrees
On startup, enumerate worktrees recorded for non-terminal/failed goals and clean
orphans; replaces the manual-prune note. Fixes hotspot #3.
Verify: create worktree, simulate crash, assert recovery cleans it.

### Phase 3 — Recover goals by reconcile-and-continue  *(core; split 3a + 3b)*
The core recovery is split into two changes so the trickiest correctness
(git/ledger/disk reconciliation) is isolated and shipped before execution resume.

- **Phase 3a — Reconcile in-flight state to clean/resumable (no resume yet).**
  Replace `recoverOrphanedSessions` force-fail-all with a per-goal reconciler
  (recovery table above): reconcile pending deliveries/integrations vs git (wire
  Phase 1's `reconcilePendingDelivery` + `listPendingDeliveries`); interrupt
  `running` worker attempts, discard their (Phase-2-cleaned) worktrees, and reset
  their tasks to a re-dispatchable state. Outcome: a crashed goal is left in a
  clean, consistent, resumable durable state (ledger + git + disk agree) — but is
  not yet auto-continued. Isolates the hardest correctness; independently testable.
- **Phase 3b — Resume execution from the durable projection.** After 3a's
  reconcile, restart the supervisor for each reconciled goal with a re-projected
  continuation prompt (`projectManagedTaskContext`), rebuilding any needed
  in-memory registry state from durable rows, instead of failing the goal. This is
  what actually delivers "survive a restart and continue." Depends on 3a.

Depends on 0–2. Together these fix the headline defect (crash = permanent goal
failure).

### Phase 4 — Supervisor session resume  *(optional quality layer)*
Persist the provider-native session id (`agent_sessions` new column); wire the
managed adapter to record it; on recovery prefer resume for the supervisor when
the provider supports it, always layered on top of the Phase 3 projection.
Best-effort: managed-mode resume is capability-gated (Codex) or unsupported
(Claude v1), so the projection path stays primary. Pure optimization; last.

## North-star acceptance (spans Phases 1–3)

> Start a goal → `kill -9` the backend mid-delegation/mid-delivery → restart →
> observe it reconcile all three worlds (ledger / disk / process), discard partial
> work, and continue from the durable projection to completion — with no duplicate
> git commit and no orphaned worktree.

When this live smoke passes, the system has moved from "crash = death" to the
"loop until deliverable" vision.

## Future candidates (not scheduled)

- **Proactive decomposition-granularity bound.** Today over-sizing is bounded
  only reactively (the two-rejection narrowing rule in task-acceptance-contracts,
  keyed on the measurable "rejection count" signal). "Too big" is a semantic
  judgment and cannot be reliably measured up front, so any proactive *size gate*
  is a gameable proxy and a prompt/skill guideline is a frequency nudge, not a
  guarantee (prompt is not enforcement). A genuinely reliable proactive bound
  would key on another *measurable* signal — e.g. a per-worker-attempt resource
  budget (time / turns / tokens) whose exhaustion is treated as an over-size
  signal that forces narrowing. Philosophy matches this whole effort: do not
  measure bigness, make mis-sized decomposition cheap to recover from.

## Non-goals (whole effort)

- Multi-user, distributed workers, or parallel children (still deferred).
- Chat-first architecture.
- Any recovery that trusts resumed AI memory over the durable ledger.
- Rich SSE cursor/replay (hotspot #8) — noted, but not scheduled here; revisit
  after the core recovery loop lands.
