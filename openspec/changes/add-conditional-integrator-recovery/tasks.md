## 1. Contracts and role configuration

- [x] 1.1 Add failing domain tests for `integrator` assignable/delegation roles, integration lifecycle statuses, candidate-bound review fields, and the `managed_integration.result` payload.
- [x] 1.2 Implement and export the Integrator role, integration contracts, and safe structured result types in the domain control-plane and provider-settings modules.
- [x] 1.3 Add failing provider-settings repository/API/dashboard tests that round-trip a sanitized `integrator` assignment and preserve fallback behavior.
- [x] 1.4 Implement `integrator` assignment parsing, backend role-adapter resolution, API read/write support, and Provider Setup rendering.
- [x] 1.5 Add failing control-block tests for one valid result plus missing, duplicate, malformed, and foreign `managed_integration.result` blocks.
- [x] 1.6 Implement strict Integrator result extraction and validation without accepting surrounding prose as authority.

## 2. Durable integration authority

- [x] 2.1 Add failing database tests for additive `managed_task_integrations` storage and nullable candidate/integration references on review and delivery records.
- [x] 2.2 Implement the additive SQLite schema, CHECK/FOREIGN KEY/UNIQUE constraints, and indexes needed to enforce one integration attempt per worker delegation and original candidate.
- [x] 2.3 Add failing managed-task repository tests for legal integration transitions, atomic audit events, one-attempt enforcement, candidate-bound re-review, and terminal interruption.
- [x] 2.4 Implement integration repository create/transition/read methods and extend review/delivery persistence with candidate and integration identities.
- [x] 2.5 Add failing reopen tests proving integration attempts, conflict files, resolved candidate SHA, and pending re-review remain authoritative after closing and reopening SQLite.
- [x] 2.6 Implement restart-safe reads and fail-closed interruption handling without duplicate automatic dispatch.

## 3. Isolated conflict reproduction and verification

- [x] 3.1 Add filesystem tests that create a real conflicting candidate and assert the supervisor worktree is restored before recovery begins.
- [x] 3.2 Extend backend delivery conflict output with checkpoint SHA, original candidate SHA, original candidate files, conflict files, and bounded Git diagnostics.
- [x] 3.3 Add failing worktree-service tests for creating and removing a runtime-owned integration worktree rooted at an exact checkpoint.
- [x] 3.4 Implement integration worktree creation, conflict reproduction with no final commit, metadata persistence hooks, and idempotent cleanup.
- [x] 3.5 Add failing verifier tests for valid resolution, moved `HEAD`, unresolved index, empty changes, out-of-scope files, and Git inspection failure.
- [x] 3.6 Implement an integration verifier that returns typed safe outcomes and never trusts Integrator test or completion claims.
- [x] 3.7 Add failing candidate-creation tests proving the backend stages only allowed paths and creates the resolved commit itself.
- [x] 3.8 Implement backend-owned resolved candidate creation and SHA/tree verification in the integration worktree.

## 4. Conditional Integrator and re-Judge orchestration

- [x] 4.1 Add failing prompt tests for the Integrator contract containing frozen criteria, exact identities, allowed/conflict files, no-commit authority, and the strict result schema.
- [x] 4.2 Implement bounded Integrator prompt construction with no raw credential, unbounded output, or provider-selection data.
- [x] 4.3 Add failing session-manager tests proving conflict-free delivery invokes no Integrator and the first verified conflict dispatches one immediately without a Supervisor control block.
- [x] 4.4 Implement backend-triggered Integrator dispatch through the existing role resolver and durable child lifecycle while retaining one active child and depth one.
- [x] 4.5 Add failing orchestration tests for unavailable role fallback, malformed result, Integrator failure/timeout/cancellation, scope verification failure, and one-attempt exhaustion.
- [x] 4.6 Implement the sequential recovery state machine and sanitized Supervisor handoff for every terminal failure path.
- [x] 4.7 Add failing Judge tests proving the original acceptance cannot authorize resolved content and the new decision must target the exact integration attempt and resolved candidate SHA.
- [x] 4.8 Implement immediate candidate-bound `review_merge` dispatch and strict re-review validation after resolved candidate creation.
- [x] 4.9 Add failing delivery tests for re-accepted success, re-review rejection/block, repeated final conflict, failed fixed validation with verified rollback, and rollback failure.
- [x] 4.10 Implement final resolved-candidate apply/validation/commit using existing backend authority and forbid a second automatic Integrator attempt.

## 5. Projection, observability, and completion

- [x] 5.1 Add failing managed-context tests for resolving, pending re-review, terminal integration failure, resolved candidate identity, and equivalent projection after database reopen.
- [x] 5.2 Extend durable context projection and supervisor observations with bounded integration status and recovery gaps.
- [x] 5.3 Add failing backend snapshot/API tests for sanitized integration read models with no raw prompts, diffs, commands, or credentials.
- [x] 5.4 Expose integration lifecycle, resolved candidate, re-review, and final delivery state through the backend read model and dashboard types/rendering.
- [x] 5.5 Add failing completion-gate tests proving unresolved, interrupted, rejected, or undelivered integration state blocks goal completion.
- [x] 5.6 Extend completion evaluation so only a re-accepted and backend-committed resolved candidate can satisfy the managed task.

## 6. End-to-end verification and documentation

- [x] 6.1 Add an end-to-end real-Git test covering Worker acceptance, observed conflict, immediate Integrator result, backend candidate creation, re-Judge acceptance, fixed validation, final commit, and durable SHAs.
- [x] 6.2 Add a restart integration test that closes/reopens SQLite between conflict detection, resolution, re-review, delivery, and completion evaluation.
- [x] 6.3 Update README, ARCHITECTURE, runtime/persistence documentation, and role descriptions to explain conditional Integrator authority and failure handoff.
- [x] 6.4 Run focused domain, persistence, provider-settings, worktree, integration, Judge, delivery, session-manager, API, dashboard, restart, and completion tests; fix only regressions attributable to this change.
- [x] 6.5 Run `npm test`, `npm run typecheck`, `openspec validate --all --strict`, and `git diff --check`; record the pre-existing agent-session timing assertion separately if it remains reproducible on unchanged `master`.
