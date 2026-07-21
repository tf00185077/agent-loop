## Context

Workspace cleanliness is judged in ~13 places by running
`git status --porcelain -uall` in the supervisor/goal workspace and treating any
non-empty output as dirty (managed-delivery-service, managed-integration-service,
review-merge-workspace-service, review-merge-verification-service,
openspec-workspace-service, managed-goal-recovery). The runtime writes
`data/auto-agent.sqlite` (+ `-wal`/`-shm`) into that repo, so a goal running
inside the auto-agent repo is always dirty and fails delivery.

`deps.database.name` exposes the runtime DB path at the manager, so the ignored
set can be derived once and threaded to the services.

## Goals / Non-Goals

**Goals:**

- A workspace whose only pending changes are the runtime's own DB files is
  clean; any other change is still dirty.
- One shared, tested decision point; robust to the configured DB path and to the
  workspace being the repo root or a subdirectory.

**Non-Goals:**

- Worker-worktree diff detection (unchanged), gitignore/DB relocation, new
  configuration, or changing any other dirtiness cause.

## Decisions

**D1 — Ignored set = the runtime DB file plus its sidecars, as absolute paths.**
Derived from `deps.database.name` (resolved to an absolute path against the
server cwd): the file itself and `${db}-wal`, `${db}-shm`, `${db}-journal`. When
`deps.database` is absent or in-memory (`:memory:`), the set is empty → today's
behavior. The set is computed once in the manager.

**D2 — A shared pure helper decides cleanliness.**
`isWorkspaceStatusClean(porcelainStdout, cwd, ignoredAbsPaths): boolean`: split
porcelain lines, take each entry's path (the portion after the 2 status
characters, and the post-`->` target for renames), resolve it to an absolute
path against `cwd`, drop entries whose absolute path is in the ignored set, and
return clean iff nothing remains. Also expose the filtered summary for the
"dirty" safe reasons so they never list the DB. Absolute-path matching means a
worktree check (no DB inside) is unaffected, so the helper is safe to use
uniformly.

**D3 — Thread the ignored paths into each supervisor-workspace check.** Add an
optional `ignoredWorkspacePaths?: string[]` to the delivery, integration,
review-merge (workspace + verification), OpenSpec, and recovery inputs; the
manager passes the computed set. Each call site swaps its raw
`status.stdout.trim().length > 0` judgment for the helper (passing the check's
`cwd`). Omitted/empty ignored set reproduces current behavior exactly.

**D4 — Only cleanliness judgments change; checkpoint/reset logic is untouched.**
The gates still record checkpoints and reset to them; only the boolean "is this
workspace clean right now" incorporates the ignore. The DB files are never part
of a candidate commit (they are outside worker worktrees), so nothing about
apply/commit changes.

**Boundaries:** the helper is pure and provider-agnostic; the manager owns
deriving the ignored set from durable config; services stay backend-only.

## Risks / Trade-offs

- [Porcelain path quoting for special characters] → The DB path
  (`data/auto-agent.sqlite`) has no special characters, so v1 porcelain does not
  quote it; the helper resolves plain paths. Documented; a `-z`/NUL parse is a
  possible future hardening, unnecessary here.
- [A genuinely intended DB change is now ignored] → The DB is runtime state, not
  product source; a goal is never meant to "deliver" a change to it. Ignoring it
  is correct, not a masked bug.
- [Applying the ignore in worktree checks] → No effect (DB absent there), so
  uniform use is safe and simpler than per-site conditionals.

## Migration Plan

Pure behavior refinement: no schema or data change. Rollback = revert; the raw
emptiness check returns. Existing goals are unaffected (a clean non-auto-agent
workspace produces an empty ignored-filtered status, same as before).

## Open Questions

- Should the ignore extend to a configurable list of "runtime-owned" paths beyond
  the DB (e.g. a future log file)? Not needed now; the DB is the only file the
  runtime writes into its own workspace.
