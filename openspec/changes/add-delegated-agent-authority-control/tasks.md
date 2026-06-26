## Implementation Protocol

- Treat this change as a control-plane change, not a dashboard-only feature.
- Keep production Codex Local managed-session wiring separate from delegated authority behavior so failures identify the right layer.
- Use fixture/mock runtime adapters for deterministic authority and continuation tests before exercising live Codex.
- Do not expose provider credentials, auth cache material, raw JSONL, shell output, access tokens, cookies, API keys, or authorization headers in persisted records or dashboard responses.

## 1. Domain Contracts

- [ ] 1.1 Add domain tests for delegated session metadata, authority request statuses, authority grant records, grant scopes, and continuation links.
- [ ] 1.2 Define framework-agnostic domain types for delegated session metadata, authority requests, authority grants, grant scopes, and continuation references.
- [ ] 1.3 Extend runtime event types with authority-requested, authority-granted, authority-rejected, and continuation-started semantics.
- [ ] 1.4 Export the new delegated authority contracts from the domain index.
- [ ] 1.5 Add sanitizer tests for authority request summaries, grant rationales, scope metadata, and continuation summaries.

## 2. Persistence

- [ ] 2.1 Add SQLite schema tests for delegated session metadata fields, authority request records, authority grant records, and continuation links.
- [ ] 2.2 Implement additive SQLite schema support for authority requests, authority grants, and delegated/continuation session metadata.
- [ ] 2.3 Add repository tests for creating authority requests, resolving them idempotently, creating grants, listing active grants, and linking continuation sessions.
- [ ] 2.4 Implement repository methods for authority request lifecycle, grant lifecycle, delegated session metadata updates, and continuation lookup.
- [ ] 2.5 Ensure persistence sanitization omits provider credentials, auth cache material, command secret arguments, cookies, access tokens, API keys, and authorization headers.

## 3. Production Codex Managed Runtime Wiring

- [ ] 3.1 Add backend tests proving saved Codex Local interactive starts route through the managed Codex runtime adapter instead of the provider smoke step.
- [ ] 3.2 Add backend tests proving per-run Codex Local overrides route through the managed Codex runtime adapter.
- [ ] 3.3 Register a production Codex runtime adapter from saved or override Codex settings when interactive runtime mode is selected.
- [ ] 3.4 Preserve an explicit one-shot provider fallback only for providers/settings configured for one-shot completion behavior.
- [ ] 3.5 Ensure Codex adapter startup or capability failures create durable managed-session failure/unsupported events rather than silently falling back to a provider smoke step.

## 4. Runtime Session Manager Authority Flow

- [ ] 4.1 Add session-manager tests for consuming authority-request events and persisting pending authority requests before streaming timeline events.
- [ ] 4.2 Implement authority-request event handling in the session manager, including lifecycle updates and durable event emission.
- [ ] 4.3 Add tests for approving authority when the runtime supports true resume and verifying the adapter receives exactly one control action.
- [ ] 4.4 Add tests for approving authority when resume is unsupported and verifying restart-as-continuation creates a linked managed session.
- [ ] 4.5 Implement restart-as-continuation orchestration with safe task/history summaries, grant scope metadata, and prior-session continuation state.
- [ ] 4.6 Add tests for rejecting authority requests and preventing continuation or grant creation.

## 5. Mock and Codex Adapter Behavior

- [ ] 5.1 Extend the mock runtime adapter to emit authority requests and exercise true-resume and restart-as-continuation test paths.
- [ ] 5.2 Add Codex runtime adapter capability tests for authority support, resume unsupported, continuation fallback metadata, cancellation, and startup failure diagnostics.
- [ ] 5.3 Implement Codex runtime capability metadata for authority and continuation behavior without exposing Codex authentication or session material.
- [ ] 5.4 Add fixture tests for Codex authority-request JSONL or unsupported-control events when the installed CLI mode cannot produce resumable authority requests.

## 6. Backend APIs

- [ ] 6.1 Add API tests for reading delegated session snapshots with authority requests, grants, active scopes, and continuation links.
- [ ] 6.2 Add API tests for approving and rejecting authority requests idempotently.
- [ ] 6.3 Implement backend routes and service methods for delegated authority snapshots, approval, rejection, and grant lookup.
- [ ] 6.4 Ensure API responses expose safe capability limitations and restart-as-continuation outcomes when runtime resume is unsupported.
- [ ] 6.5 Ensure all delegated authority API responses omit credential material and raw provider payloads.

## 7. Dashboard Controls

- [ ] 7.1 Add dashboard rendering tests for delegated session relationships, authority request cards, grant scopes, rejection state, and continuation links.
- [ ] 7.2 Render delegated managed sessions in goal detail using backend session snapshots and durable streamed events.
- [ ] 7.3 Add approve/reject controls for pending authority requests and wire them to backend authority APIs.
- [ ] 7.4 Show safe runtime limitation messaging when approval uses restart-as-continuation instead of true resume.
- [ ] 7.5 Verify historical one-shot goals and sessions without delegation metadata still render without errors.

## 8. Status and Tree Alignment

- [ ] 8.1 Update or annotate `add-agent-live-status-model` so live status can surface waiting-for-authority, granted-authority, rejected-authority, and continuation states.
- [ ] 8.2 Update or annotate `add-multi-agent-run-tree` so run-tree nodes prefer delegated managed-session metadata and authority state over inferred free-form observation relationships.
- [ ] 8.3 Add migration notes explaining how delegated authority events coexist with existing observability, approval, and child-session events.

## 9. Verification

- [ ] 9.1 Run focused domain, sanitizer, persistence, API, session-manager, mock-adapter, Codex-adapter, and dashboard tests.
- [ ] 9.2 Run typecheck and the full test suite, documenting unrelated pre-existing failures if any.
- [ ] 9.3 Run browser verification showing a delegated fixture-backed session reaches pending authority, approved grant, restart-as-continuation, rejection, and terminal states through dashboard controls.
- [ ] 9.4 Run `openspec validate add-delegated-agent-authority-control --strict`.
