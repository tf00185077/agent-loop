## Context

Verified against the real Codex CLI (v0.144): `codex exec resume [SESSION_ID]
[PROMPT]` resumes a prior session; `-` reads the prompt from stdin, and `--json
--skip-git-repo-check --sandbox` apply as in fresh `exec`. `buildCodexManagedSessionArgs`
currently always builds `["exec", …, "-"]`. The capability probe hard-codes
`approvalResume: false` and maps both `approval` and `resume` capabilities to it.
Phase 4a persists the provider session id on `agent_sessions`.

## Goals / Non-Goals

**Goals:** invoke `codex exec resume` with the persisted session id when supported,
falling back to fresh; derive the `resume` capability from real CLI support.

**Non-Goals:** Claude resume; changing the continuation prompt; 3a/3b/4a behavior.

## Decisions

**1. The adapter decides resume vs fresh; the manager just supplies the id.**
`resumeInterruptedGoal` passes the last session's persisted `providerSessionId` as
`AgentSessionStartInput.resumeSessionId`. The Codex adapter uses it only when it
also reports the `resume` capability; otherwise it ignores it and starts fresh.
This keeps the resume decision next to the CLI knowledge and makes the manager
provider-agnostic. The continuation prompt (state-truth floor) is always the
stdin message, whether resuming or fresh.

**2. Resume args.** When `resumeSessionId` is present and supported,
`buildCodexManagedSessionArgs` builds `["exec", "resume", <id>, "--skip-git-repo-check",
"--json", "--sandbox", "workspace-write", …model, "-"]`. Otherwise unchanged.

**3. Capability detection.** The probe adds `sessionResume`, detected from `codex
exec --help` containing the resume subcommand ("Resume a previous session"). The
`resume` capability maps to `sessionResume` (not `approvalResume`); `approval`
still maps to `approvalResume`. Absent/failed probe ⇒ `resume: false` ⇒ fresh.

## Risks / Trade-offs

- [CI cannot run the real Codex CLI] → The args builder, capability detection
  (from captured help text), and manager wiring are unit-tested with fixtures; the
  actual transcript replay is verified manually against the real CLI (documented
  in verification.md). This is the one place real-CLI verification is required.
- [Resumed transcript disagrees with the reconciled ledger] → The continuation
  prompt still carries the durable projection, so state truth is re-asserted after
  resume (the Phase 3b caveat holds); resume adds reasoning continuity only.
- [Wrong/unknown session id] → Codex resume fails; the adapter surfaces a
  `session.failed`, which 3b's best-effort catch already leaves recoverable on the
  next boot.

## Migration Plan

No schema change. Additive input field + adapter branch. Rollback removes the
resume branch; the manager simply stops passing the id.

## Open Questions

- Should a failed resume automatically retry as a fresh session in the same boot,
  or wait for the next boot? Deferred: rely on 3b's next-boot reconcile+resume;
  revisit if same-boot fallback proves worthwhile once observed on the real CLI.
