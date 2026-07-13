# Tasks: add-role-agent-assignments

## 1. Domain Types + Settings Persistence

- [x] 1.1 Add domain types: `AgentAssignableRole` (`worker | spec_writer | review_merge`), `AgentRoleAssignment {provider, modelLabel, commandPath}`, `roleAssignments` on provider settings; sanitization of assignment command paths.
- [x] 1.2 Add tests + implementation: `role_assignments` JSON column (additive `ensureColumn` + schema test), repository save/read round-trip with sanitization, absent assignments read as undefined.

## 2. Provider-Settings API

- [x] 2.1 Add API tests: PUT round-trips `roleAssignments`; unknown role/provider or malformed shapes → 400 with settings unchanged; GET after restart returns saved assignments; credential-like path arguments come back sanitized.
- [x] 2.2 Implement route validation and pass-through.

## 3. Role-Adapter Resolver + Dispatch Wiring

- [x] 3.1 Add resolver tests: no assignment → null; injected adapter precedence; constructed codex/claude adapters from assignment path with detection self-healing; per-goal capability cache.
- [x] 3.2 Implement `createRoleAdapterResolver` in the backend (reusing adapter constructors, probes/session-runner seams, and CLI path resolution) and thread it from `selectRuntimeForSettings` into the session manager.
- [x] 3.3 Add session-manager tests: worker delegation with an assignment dispatches the child on the resolved adapter/provider/model (run row + event metadata show the resolved agent); review_merge assignment respected; unassigned role unchanged.
- [x] 3.4 Implement role resolution at dispatch in `persistDelegationControlEvent` (resolved trio passed to the coordinator).
- [x] 3.5 Add tests + implementation for capability-gated fallback: unsupported/unresolvable assignment → durable `role_assignment.downgraded` (role, provider, safe reason) → dispatch on the goal default adapter.

## 4. Dashboard Controls

- [x] 4.1 Add per-role assignment controls to provider setup (inherit toggle, provider picker, model label, command path) wired to the settings API.
- [x] 4.2 Add/adjust dashboard tests for the new controls and payload.

## 5. Verification

- [x] 5.1 Run typecheck and the full test suite; document any unrelated pre-existing failures. (384 tests, 0 failures; typecheck clean.)
- [x] 5.2 Update README (role assignment section) and run `openspec validate add-role-agent-assignments --strict`.
- [x] 5.3 Live mixed-provider smoke when both CLIs are available (Codex supervisor + Claude worker); capture resolved-agent evidence in `verification.md`. (Claude worker flake triggered the narrowing rule live; narrowed task succeeded on Claude.)
