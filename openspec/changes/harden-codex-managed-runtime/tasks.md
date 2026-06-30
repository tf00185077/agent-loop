## 1. MVP Codex Invocation

- [x] 1.1 Keep the base invocation on `codex exec --json -` with prompt content on stdin.
- [x] 1.2 Add tests for command argument construction with Codex CLI default and configured model paths already supported by provider setup.

## 2. Session Identity and Resume

- [x] 2.1 Extend Codex session params to store session id, cwd, known model/options, and capability metadata.
- [x] 2.2 Parse Codex session/thread start JSONL events and persist session identity.
- [x] 2.3 Implement true resume invocation through `codex exec --json resume <sessionId> -` when enabled and supported.
- [x] 2.4 Implement fallback to fresh continuation when resume is unsupported or the session is unknown.
- [x] 2.5 Add tests for resume success, unknown-session fallback, and no-resume capability fallback.

## 3. MVP JSONL Parser

- [x] 3.1 Add parser fixtures for session/thread start, assistant message, error, unknown JSON, and malformed line cases.
- [x] 3.2 Emit typed provider observations for assistant messages, errors, and diagnostics.
- [x] 3.3 Preserve unknown and malformed output as diagnostic records without crashing the run.
- [x] 3.4 Add parser tests covering the MVP JSONL cases.

## 4. Runtime Diagnostics

- [ ] 4.1 Detect missing Codex command separately from command execution failure.
- [ ] 4.2 Classify Codex authentication failures separately from generic failures.
- [ ] 4.3 Add tests for missing command, auth failure, and unknown failure diagnostics.

## 5. Control Plane Integration

- [ ] 5.1 Expose Codex managed runtime capabilities through the provider interface.
- [ ] 5.2 Update runtime continuation flow to choose true resume or fresh continuation from provider capabilities.
- [ ] 5.3 Ensure higher-level runtime code uses transport-independent continuation input rather than Codex command syntax.
- [ ] 5.4 Add runtime tests for provider capability-driven continuation behavior.

## 6. Verification and Documentation

- [ ] 6.1 Document that Codex is the first reference adapter, not the permanent provider boundary.
- [ ] 6.2 Run `npm run typecheck`.
- [ ] 6.3 Run `npm test`.
- [ ] 6.4 Run `openspec validate harden-codex-managed-runtime --strict`.
