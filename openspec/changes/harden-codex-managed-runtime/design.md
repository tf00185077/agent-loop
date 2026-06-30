## Context

auto-agent currently treats Codex as the first practical adapter for local development. The product remains adapter-agnostic, but Codex must be reliable enough for the MVP delegation loop: supervisor starts work, child sessions run, results return, and the supervisor continues.

Paperclip and auto-agent both rely on the same core Codex CLI shape: `codex exec --json -` with the prompt on stdin. Paperclip adds useful hardening around session params, resume, managed home, parsing, and diagnostics. This MVP keeps only the parts needed for managed delegation and records the rest as future work.

## Goals / Non-Goals

**Goals:**
- Preserve the provider adapter boundary while making Codex the first stable reference adapter.
- Capture Codex session identity and minimum invocation parameters from JSONL output.
- Use true Codex resume when available and fall back to fresh continuation when resume fails.
- Parse MVP JSONL events for session start, assistant output, errors, and diagnostics.
- Report Codex capability metadata to the runtime control plane.
- Distinguish missing command and authentication failures from generic command failure.

**Non-Goals:**
- Replacing the generic provider model with Codex-only abstractions.
- Implementing Paperclip organization/workspace/remote-sandbox concepts.
- Requiring managed delegation to wait for perfect resume support.
- Implementing managed `CODEX_HOME`, output inactivity monitoring, optional invocation tuning, or usage accounting in the MVP.

## Decisions

1. **Keep `codex exec --json -` as the base invocation.**
   - Decision: all MVP Codex sessions start from the same JSONL exec mode auto-agent already targets.
   - Rationale: this keeps provider output observable and avoids a larger wrapper service.
   - Alternative considered: wrap Codex with a custom server. Deferred until the control plane proves its shape.

2. **Persist minimum session params separately from prompt content.**
   - Decision: store session id, cwd, model/options when already known, and resume capability metadata as runtime session params.
   - Rationale: continuations need enough identity to choose true resume versus fallback without leaking full prompt content into control fields.
   - Alternative considered: infer resume state from recent events only. Rejected because event text is not a reliable execution contract.

3. **Resume when verified, fallback when not.**
   - Decision: use `codex exec --json resume <sessionId> -` when a prior session id exists and adapter capability allows it; if Codex reports an unknown session or unsupported resume, start a fresh continuation prompt.
   - Rationale: supervisor continuation must be dependable even while Codex resume behavior changes.
   - Alternative considered: require true resume. Rejected because that would block MVP delegation on one adapter detail.

4. **Parse only control-critical JSONL first.**
   - Decision: parse session/thread start, assistant message, error, and malformed/unknown diagnostics in the MVP.
   - Rationale: these events are enough to drive continuation and surface failures.
   - Alternative considered: parse every Paperclip-observed event now. Deferred to keep the MVP tight.

## Risks / Trade-offs

- [Codex JSONL event names can change] -> Keep parser tests fixture-based and preserve unknown records for diagnostics.
- [Resume may fail across cwd or CLI changes] -> Store original session params and fallback to fresh continuation with an explicit event.
- [Less runtime isolation in MVP] -> Keep credential-sensitive details backend-only and revisit managed home after the delegation loop works.

## Migration Plan

1. Add Codex runtime configuration for resume enablement and minimal invocation options already needed by current provider setup.
2. Extend Codex JSONL parser tests with fixtures for session/thread start, assistant message, error, unknown JSON, and malformed lines.
3. Persist Codex session params when a session starts.
4. Add resume attempt and fallback continuation flow.
5. Expose adapter capability metadata to the runtime control plane.
6. Roll back by disabling resume; basic `codex exec --json -` remains available.

## Open Questions

- Which Codex CLI event names should be considered canonical for the installed version in the development environment?
