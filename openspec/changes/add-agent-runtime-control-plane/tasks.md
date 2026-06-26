## Implementation Protocol

- Treat each non-test code-change step as its own commit. Finish the step, run the relevant focused verification, and commit before starting the next code-change step.
- Treat test-only steps at the same `##` level as one batch. Complete all test-only tasks in that section, run that section's tests once through Codex as the agent, and commit the passing test batch together.
- After completing every `##` section, run the full project verification suite once, including typecheck, full tests, relevant browser verification when applicable, and OpenSpec strict validation if the CLI is available. Commit any required fixes before moving to the next section.
- All agent-backed test runs and verification scenarios must use Codex as the agent/provider.
- Do not commit a task or section checkpoint until its required verification passes, unless the commit explicitly documents an unrelated pre-existing failure.

## 1. Domain Contracts

- [x] 1.1 Add tests for managed agent session lifecycle states, runtime capabilities, command records, approval requests, and child-session request metadata.
- [x] 1.2 Define framework-agnostic domain types for agent sessions, runtime events, runtime adapters, approval requests, command records, and child-session requests.
- [x] 1.3 Export the new control-plane contracts from the domain index and update existing provider/runtime type references where needed.
- [x] 1.4 Add sanitizer tests for approval summaries, command metadata, runtime diagnostics, and child-session request summaries.

## 2. Persistence and API Surface

- [x] 2.1 Add persistence tests for creating sessions, updating lifecycle state, storing pending approvals, resolving approvals idempotently, and recording child-session requests.
- [x] 2.2 Implement SQLite schema/store support for durable agent sessions, approval requests, command records, runtime capabilities, and child-session request records.
- [x] 2.3 Add backend API tests for session snapshot reads, approve, reject, cancel, and provider capability responses.
- [x] 2.4 Implement backend routes and service methods for session snapshots and session-control actions.
- [x] 2.5 Ensure all API responses omit provider credentials, auth cache material, command secret arguments, cookies, access tokens, API keys, and authorization headers.

## 3. Runtime Session Manager

- [x] 3.1 Add tests for starting a managed session, consuming adapter events, persisting timeline events before streaming, and updating current session state.
- [x] 3.2 Implement the runtime session manager that owns session lifecycle transitions, durable events, approval state, cancellation state, and adapter registration.
- [x] 3.3 Add tests for backend restart or adapter-loss recovery policy for non-terminal sessions.
- [x] 3.4 Implement recovery handling for orphaned non-terminal sessions so they become visibly stalled, failed, or cancelled rather than indefinitely running.
- [x] 3.5 Wire interactive provider-backed goal starts through the session manager while preserving one-shot provider behavior for mock/OpenAI-compatible completion providers.

## 4. Mock Runtime Adapter

- [x] 4.1 Add tests for a mock runtime adapter that emits progress, command events, approval requests, child-session requests, completion, failure, and cancellation events.
- [x] 4.2 Implement the mock runtime adapter behind the `AgentRuntimeAdapter` contract.
- [x] 4.3 Add tests proving approve, reject, and cancel actions reach the active adapter exactly once.
- [x] 4.4 Use the mock adapter in backend/runtime tests to verify control-plane behavior without live provider credentials.

## 5. Codex Runtime Adapter Spike

- [x] 5.1 Run a Codex CLI capability spike for JSONL session events, cancellation behavior, and backend-mediated approval/resume feasibility.
- [x] 5.2 Document the verified Codex CLI command mode and any unsupported control capabilities in code-facing comments or adapter capability metadata.
- [x] 5.3 Add fixture tests for Codex runtime capability detection, approval-supported mode, approval-unsupported mode, cancellation, and startup failures.
- [x] 5.4 Implement Codex runtime adapter capability detection without exposing Codex authentication or session material.

## 6. Codex Managed Session Execution

- [ ] 6.1 Add Codex adapter tests proving JSONL/runtime events map to managed session events and durable goal events.
- [ ] 6.2 Implement Codex managed session startup, event streaming, final completion, failure handling, and process cleanup.
- [ ] 6.3 Add tests for Codex approval request mapping when supported, or clear unsupported-control failure when approval cannot be resumed by the CLI mode.
- [ ] 6.4 Implement Codex approval/cancellation handling according to the verified capability result.
- [ ] 6.5 Add Windows command-diagnostic tests for blocked PowerShell `.ps1` shims and safe retry guidance such as `npm.cmd`.

## 7. Dashboard Session Controls

- [ ] 7.1 Add dashboard state/rendering tests for managed session state, runtime capabilities, pending approval requests, resolved approvals, cancellation support, and unsupported-control messaging.
- [ ] 7.2 Render session state and provider/model metadata on the goal detail view without breaking one-shot provider or historical goals.
- [ ] 7.3 Add approve/reject controls for pending approval requests and wire them to backend session-control APIs.
- [ ] 7.4 Add cancel controls when cancellation is supported and hide or disable them when unsupported.
- [ ] 7.5 Verify dashboard updates session and approval state from durable snapshots plus streamed events without direct provider output access.

## 8. Follow-up Change Alignment

- [ ] 8.1 Update or annotate `add-agent-live-status-model` so live status derives from control-plane session/runtime events where applicable.
- [ ] 8.2 Update or annotate `add-multi-agent-run-tree` so run-tree parent/child nodes use session and child-session request metadata.
- [ ] 8.3 Add migration notes explaining how existing observability events coexist with managed session events.

## 9. Verification

- [ ] 9.1 Run focused domain, persistence, API, session-manager, mock-adapter, Codex-adapter, and dashboard tests.
- [ ] 9.2 Run typecheck and the full test suite, documenting any unrelated pre-existing failures.
- [ ] 9.3 Run browser verification showing a managed Codex or fixture-backed agent session reaches running, waiting-for-approval, approval-resolved, and terminal states through dashboard controls.
- [ ] 9.4 Run `openspec validate add-agent-runtime-control-plane --strict`.
