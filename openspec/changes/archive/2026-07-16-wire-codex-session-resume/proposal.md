## Why

Phase 4b completes provider-native resume: Phase 4a persists the Codex session
id, and the real Codex CLI (verified: `codex exec resume [SESSION_ID] [PROMPT]`,
prompt via `-` on stdin) supports resuming a prior session. Today the managed
Codex adapter always spawns a fresh `codex exec` and reports `resume: false`
(hard-coded via `approvalResume`), so 3b always restarts from a re-projected
prompt. This change wires true Codex resume: when a persisted session id exists
and the CLI supports resume, the resumed supervisor session replays the prior
transcript and receives the continuation prompt as its next message — reasoning
continuity on top of 3b's state-truth floor.

## What Changes

- Add an optional `resumeSessionId` to `AgentSessionStartInput`.
- The managed Codex adapter builds `exec resume <sessionId> … -` (instead of
  `exec … -`) when `resumeSessionId` is set and the adapter reports resume
  support; otherwise it starts fresh. The continuation prompt is still delivered
  (on stdin) as the post-resume message.
- The Codex capability probe detects session-resume support from `codex exec
  --help` (the `resume` subcommand) and maps it to the `resume` capability,
  separate from approval resume.
- `resumeInterruptedGoal` passes the interrupted goal's last persisted
  `providerSessionId` as `resumeSessionId`; the adapter decides whether to use it,
  falling back to a fresh continuation when resume is unsupported or no id exists.

Non-goals: Claude resume (its adapter still returns text with no session id —
unchanged); changing 3a/3b/4a; any change to the continuation prompt content.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `codex-managed-runtime`: refine the existing "resumes when available"
  requirement so the managed adapter detects session-resume support and invokes
  `codex exec resume` with a known session id, falling back to a fresh session
  otherwise.

## Impact

- `src/domain/agent-runtime-control-plane.types.ts` — `resumeSessionId` on
  `AgentSessionStartInput`.
- `src/runtime/providers/codex/codex-runtime-adapter.ts` — resume args in
  `buildCodexManagedSessionArgs`, resume-capability detection in the probe,
  `resume` capability mapped from session-resume.
- `src/runtime/agent-session/agent-session-manager.ts` —
  `resumeInterruptedGoal`/`startManagedSession` thread `resumeSessionId` from the
  persisted provider session id.
- No SQLite schema change.
