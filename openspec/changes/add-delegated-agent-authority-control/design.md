## Context

`add-agent-runtime-control-plane` established managed local agent sessions, provider-agnostic runtime events, approval requests, cancellation, and future child-session metadata. The current implementation still has a practical gap: production Codex Local can fall back to one-shot provider smoke execution, and the existing Codex adapter reports approval/resume as unsupported unless a CLI mode proves otherwise.

The intended product direction now requires Codex-started delegated agents that are not necessarily strict subprocess "children", but still have visible hierarchy, supervision, and authority boundaries. A delegated agent may need additional permission during execution. The system therefore needs a durable just-in-time authority model that works even before Codex can resume an already-paused approval.

## Goals / Non-Goals

**Goals:**

- Ensure interactive Codex Local work can enter the managed session control plane in production.
- Represent delegated agent relationships as durable managed-session metadata.
- Persist authority requests and grant/reject decisions separately from ordinary command approvals.
- Allow a user, and later a supervising agent policy, to approve additional authority only when needed.
- Support a restart-as-continuation fallback when the selected runtime cannot resume the same process after approval.
- Keep dashboard controls backend-mediated and credential-safe.
- Provide enough durable metadata for live status and run tree features to show delegated authority state.

**Non-Goals:**

- Do not build distributed workers, remote execution, or multi-user authorization.
- Do not require Codex CLI to support true in-process approval resume before this change can ship.
- Do not let the dashboard talk directly to Codex processes, stdout, stderr, auth cache, or shells.
- Do not implement broad autonomous auto-approval policy in the first pass.
- Do not replace the existing one-shot provider path for providers explicitly configured as one-shot completions.

## Decisions

1. Treat delegation as managed-session relationship metadata.

   A delegated agent is a managed session with fields such as `supervisorSessionId`, `delegatedBySessionId`, `delegationRole`, `taskId`, and safe task summary. The relationship is semantic rather than process-based: a Codex-started delegated agent may be a fresh Codex session, but the backend still owns the durable relationship.

   Alternative considered: infer delegated agents only from Codex stdout or free-form messages. That would make the dashboard and run tree guess at authority boundaries and would fail after refresh.

2. Separate authority requests from command approvals.

   Existing approval requests describe a concrete command or action that needs a yes/no decision. Authority requests describe a capability scope that an agent wants to obtain, such as workspace write access, command execution, dependency installation, or child delegation. They need their own durable status and grant records because a single grant can authorize later work within a bounded scope.

   Alternative considered: reuse command approvals for all authority decisions. That would blur "approve this command once" with "grant this agent a temporary capability" and would make delegated sessions difficult to reason about.

3. Use explicit grant scopes.

   Authority grants should carry a minimal scope: target session, granted capabilities, optional task/session boundary, requester, approver type, created/resolved timestamps, expiration or terminal-session boundary when supported, and safe rationale. The MVP can keep capabilities as a small string-literal union while preserving a metadata field for safe provider-specific diagnostics.

   Alternative considered: store a free-form permission string. That is flexible, but too ambiguous to test or render safely.

4. Prefer true resume, but support restart-as-continuation.

   If a runtime adapter supports approval/resume, approving an authority request can resume the active session. If it does not, the backend should resolve the request and start a new managed session with the grant scope, original delegation metadata, safe task summary, safe recent history summary, and a `continuationOfSessionId` link. The prior session should reach a visible terminal or superseded state rather than silently hanging.

   Alternative considered: block the feature until Codex supports resumable approval. That would prevent useful delegated workflows even though a fresh authorized Codex session can carry the work forward.

5. Production Codex interactive starts must register the managed adapter.

   Delegation and just-in-time authority cannot work if a Codex Local goal enters the legacy provider smoke runtime. The production app should create a Codex runtime adapter from saved or per-run Codex settings when the provider is selected for interactive runtime use. The one-shot provider path remains available only for explicitly one-shot providers or an explicit fallback setting.

   Alternative considered: leave adapter injection test-only. That preserves tests, but production users cannot exercise the control plane.

6. Dashboard authority controls stay backend-only.

   The dashboard should show delegated sessions, pending authority requests, grants, rejections, unsupported resume limitations, and continuation links. It should approve or reject through backend APIs only. Provider process details, credentials, raw JSONL, and shell IO remain backend-owned.

   Alternative considered: make dashboard controls provider-specific. That would leak Codex concepts into the UI and make Claude or future adapters harder to support.

## Risks / Trade-offs

- [Risk] Restart-as-continuation may lose some live process context. -> Mitigation: persist safe history summaries, link continuation sessions, and show the restart explicitly in the timeline.
- [Risk] Authority scopes can become too broad. -> Mitigation: start with a small allowlisted capability set and require safe summaries for any provider-specific details.
- [Risk] Production Codex adapter capability probing may fail on some local installs. -> Mitigation: report unsupported capabilities durably and keep an explicit one-shot fallback path.
- [Risk] Delegation overlaps with the active run-tree change. -> Mitigation: make session relationship records the source of truth and let run-tree consume them later.
- [Risk] Users may expect approval to resume the exact same Codex process. -> Mitigation: surface whether the runtime used true resume or restart-as-continuation for each grant.

## Migration Plan

1. Add domain contracts and persistence for delegated session metadata, authority requests, authority grants, and continuation links.
2. Wire production Codex Local interactive starts through the managed runtime adapter and expose unsupported approval/resume state when applicable.
3. Add backend APIs for authority snapshot, request approval/rejection, and grant materialization.
4. Extend the runtime session manager to translate authority events, create grants, and start continuation sessions when true resume is unsupported.
5. Update dashboard goal detail to show delegated sessions, pending authority requests, grant decisions, and continuation outcomes.
6. Update tests and fixture adapters to exercise true-resume and restart-as-continuation paths without relying on live provider credentials.

Rollback is possible by disabling interactive Codex session mode and returning Codex Local to the existing one-shot provider path, with delegated authority controls reported as unsupported.

## Open Questions

- Which initial authority scopes should be exposed in the UI: command execution, workspace write, dependency install, delegation, or a smaller subset?
- Should a supervising agent ever be allowed to approve authority automatically, or should the first pass require the local user for all grants?
- Should a superseded session use a new lifecycle state or reuse `cancelled`/`failed` with explicit continuation metadata?
