## Context

Verified on the real Codex CLI (v0.144): `codex exec resume [OPTIONS] [SESSION_ID]
[PROMPT]` has no `-s/--sandbox`; it exposes `-c/--config <key=value>`. A dry run of
`codex exec resume <uuid> -c sandbox_mode=workspace-write --skip-git-repo-check
--json -` parses cleanly (fails later only on the empty prompt / unknown session),
confirming the corrected invocation. The current `buildCodexManagedSessionArgs`
resume branch wrongly reuses `--sandbox workspace-write`. Separately, the adapter's
event loop yields `session.failed` on a subprocess error (it does not throw), so a
broken resume is not caught by the manager's Phase 3b best-effort revert and the
goal is force-failed.

## Goals / Non-Goals

**Goals:** correct resume args; make a failed resume degrade to a fresh session.

**Non-Goals:** changing fresh `codex exec` args, 3a/3b, or Claude.

## Decisions

**1. Config-based sandbox for resume.** The resume args become `exec resume <id>
--skip-git-repo-check --json -c sandbox_mode=workspace-write [-m model] -`. Fresh
`codex exec` keeps `--sandbox workspace-write` (still valid there).

**2. Resume→fresh fallback inside the adapter.** Extract the per-run consumption
into a local async generator `runAttempt(runnerInput)` that yields runtime events
and returns the run outcome (completed / cancelled / in-band error). The event
loop runs the resume attempt first; if it *throws* (subprocess failed to start or
exited nonzero) and a resume id was used, it records a `session.state_changed`
note and re-runs `runAttempt` with `resumeSessionId: null` (fresh). Only a
fresh-run failure yields `session.failed`. This localizes the fallback to the
provider that knows resume can fail, keeps the continuation prompt (state truth),
and matches the "resume unavailable → fresh" requirement.

## Risks / Trade-offs

- [A genuinely failing task now retries fresh once] → Acceptable and bounded: the
  fresh attempt is one continuation; downstream completion/continuation caps still
  apply. A fresh continuation is strictly better than force-failing the goal.
- [CI cannot run the real Codex CLI] → The corrected args are unit-tested and were
  dry-verified against the real CLI; the fallback is unit-tested with a session
  runner that throws.

## Migration Plan

No schema change. The goal currently `failed` by the old bug can be re-run after
the fix (or manually reset to `interrupted` for the next boot to resume).

## Open Questions

- Should repeated resume failures disable resume for the goal (stop retrying
  resume every boot)? Deferred: the fresh fallback already prevents a stuck loop;
  revisit if real runs show churn.
