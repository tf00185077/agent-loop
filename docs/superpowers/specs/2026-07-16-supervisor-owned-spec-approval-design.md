# Supervisor-Owned Spec Approval Design

## Context

Large managed goals currently create a synthetic `spec:<changeId>` task for each
planned change. The task is delegated with `role: "worker"`, while its task ID
causes the runtime to append spec-authoring instructions and apply the S1-S3
OpenSpec validation contract. Separately, provider settings expose
`spec_writer` as an assignable child role, even though managed delegation does
not accept that role and spec tasks do not resolve their agent through it.

This design makes the runtime model explicit: spec authoring is a specialized
worker task, not a distinct agent identity. The Supervisor owns the semantic
intent of each change and must approve the worker-authored spec before it can be
reviewed and merged.

## Goals

- Remove `spec_writer` as a configurable or runtime agent identity.
- Keep spec authoring inside the normal worker/worktree task pipeline.
- Make the Supervisor the semantic owner and approval authority for specs.
- Persist approval decisions so they survive process restart and can be
  reconstructed from durable state.
- Prevent review-merge of a spec attempt that has not received Supervisor
  approval.
- Preserve backend-owned structural validation before approval and after merge.
- Reset the current development SQLite database instead of supporting legacy
  `spec_writer` settings or migrating existing test data.

## Non-Goals

- Binding Supervisor approval to a Git candidate commit SHA.
- Guaranteeing that a worktree cannot change between approval and review-merge.
- Adding a dedicated spec-authoring provider or model setting.
- Reusing the same agent session for spec authoring and implementation.
- Having the Supervisor directly edit OpenSpec artifacts.
- Replacing independent review-merge or backend structural validation.

## Role Boundaries

### Supervisor

- Decides whether a goal requires a change plan.
- Defines change boundaries, ordering, title, rationale, and dependencies.
- Reviews the latest structurally valid spec result for semantic fitness.
- Approves or rejects the result with a concise durable summary.
- On rejection, delegates a corrective attempt for the same spec task.

The Supervisor owns the meaning of the spec but does not author files in the
worker worktree or the goal workspace.

### Worker

Both spec authors and implementation agents use the existing `worker` role.
They normally run in separate sessions and worktrees:

- A spec worker explores the repository and writes the proposal, delta specs,
  and task list for `spec:<changeId>`.
- After approval and merge, one or more new worker sessions implement the
  approved tasks.

Using separate sessions makes the approved documents the handoff boundary and
tests whether they are sufficiently clear for an implementer without hidden
conversation context.

### Backend

- Creates and freezes the `spec:<changeId>` task contract.
- Scaffolds OpenSpec artifacts.
- Applies S1-S3 validation to the worker result before it reaches Supervisor
  approval.
- Validates approval control events and persists accepted decisions.
- Gates spec review-merge on a matching approval.
- Validates merged artifacts again before advancing the change.

### Review-Merge

Review-merge remains an independent role. It may only review and merge a spec
worker attempt after the Supervisor has approved that attempt. Supervisor
approval does not imply merge success and does not bypass review criteria,
delivery checks, or post-merge OpenSpec validation.

## Workflow

```text
Supervisor records change plan
  -> backend registers spec:<changeId>
  -> worker authors artifacts in its worktree
  -> backend validates S1-S3
     -> invalid: reject the attempt with cited structural failures
     -> valid: ask Supervisor for semantic review
        -> reject: persist reason and delegate a corrective spec attempt
        -> approve: persist approval and unlock review-merge
           -> review-merge rejects: return through the existing correction flow
           -> review-merge merges: validate artifacts in the goal workspace
              -> invalid: remain specifying
              -> valid: transition change to executing
```

The change remains in `specifying` throughout authoring, Supervisor review, and
review-merge. Approval alone never moves the change to `executing`.

## Supervisor Review Control Event

The Supervisor emits one structured event:

```json
{
  "type": "managed_change.spec_review",
  "changeId": "change-one",
  "workerDelegationRequestId": "worker-request-123",
  "decision": "approve",
  "summary": "The specification covers the intended behavior and boundaries."
}
```

Fields:

- `changeId`: the active managed change.
- `workerDelegationRequestId`: the exact spec worker attempt being reviewed.
- `decision`: `approve` or `reject`.
- `summary`: a required, non-empty semantic rationale. For rejection it must
  describe what needs revision.

The first version intentionally has no `candidateCommitSha` and no per-criterion
decision array. S1-S3 remain backend structural criteria; the Supervisor makes
a single semantic decision.

## Validation Rules

The backend accepts a spec review only when all of the following are true:

1. The change exists and is the active change.
2. The change is still `specifying`.
3. The task is exactly `spec:<changeId>`.
4. `workerDelegationRequestId` identifies the latest attempt for that task.
5. That attempt completed with a successful result.
6. The artifacts for that attempt passed the pre-merge S1-S3 validation gate.
7. The decision and summary are well formed.

An identical repeat of an already accepted decision is idempotent. A later
decision that conflicts with the durable decision for the same attempt is
rejected. Starting a new spec attempt invalidates the prior attempt's approval
for gating purposes, without deleting its audit history.

A `review_merge` request for a spec task is rejected unless its
`workerDelegationRequestId` has a current Supervisor approval. Non-spec worker
review behavior is unchanged.

## Persistence and Rehydration

Accepted approvals and rejections are durable. The stored record or event must
contain at least:

- goal ID
- run ID
- change ID
- spec task ID
- worker delegation request ID
- decision
- summary
- creation timestamp

Rehydration reconstructs the latest review state for each spec attempt and the
approval that currently unlocks review-merge. It must not infer approval merely
from a successful worker result, a structural validation event, or a completed
review-merge.

Durable runtime events should distinguish at least:

- `change.spec_review_requested`
- `change.spec_supervisor_approved`
- `change.spec_supervisor_rejected`
- rejected or malformed control requests through the existing delegation
  rejection event mechanism

## Prompt and Continuation Changes

The Supervisor contract must state that a structurally valid spec result awaits
its semantic decision. The continuation following a spec worker result must
identify the change, task, worker delegation request, validation outcome, and a
bounded summary of the authored artifacts sufficient for the decision.

The Supervisor must not dispatch review-merge before approving. On rejection,
the next worker prompt must include the Supervisor's durable summary so the
revision addresses the semantic concern.

The existing provider-neutral spec-authoring appendix and S1-S3 contract remain
attached by task type. They are not tied to an agent role.

## Removal of the `spec_writer` Identity

Remove `spec_writer` from:

- assignable-role domain types and exported role lists
- provider-settings sanitization and resolution paths
- Provider Setup labels and controls
- role-adapter resolver tests and fixtures
- README descriptions of configurable child agents

Keep human-readable phrases such as "spec writer" only where they describe the
worker's current task, not an addressable runtime role. Prefer "spec worker" or
"spec-authoring worker" in new code and documentation.

## Development Database Reset

All data currently stored in the development SQLite database is test data and
will be discarded during implementation. The reset covers the entire database,
including goals, runs, sessions, tasks, events, reviews, deliveries, and
provider settings.

The reset is an implementation/development operation, not an application
migration:

- Do not add backward-compatible parsing for `roleAssignments.spec_writer`.
- Do not add a schema/data migration whose purpose is preserving current rows.
- Recreate an empty database using the current schema after the code changes
  are ready.
- Do not commit a populated or locally modified SQLite database.

## Failure Handling

- Structural validation failure: reject before Supervisor review and cite S1-S3.
- Malformed Supervisor decision: reject without changing approval state.
- Stale attempt: reject and name the latest attempt.
- Semantic rejection: persist the reason and return to authoring under the
  existing retry budget.
- Retry budget exhaustion: preserve the current blocked-change behavior.
- Review-merge requested without approval: reject and keep the change
  `specifying`.
- Review-merge rejection: keep the change `specifying`; the subsequent attempt
  requires a new Supervisor approval.
- Post-merge validation failure: keep the change `specifying` and record the
  structural failures durably.
- Restart: rehydrate the durable decision and continue from the same gate.

## Testing Strategy

### Domain and validation

- `spec_writer` is absent from assignable roles and provider settings.
- A valid `managed_change.spec_review` is accepted.
- Missing fields, invalid decisions, empty summaries, inactive changes, stale
  attempts, and unvalidated attempts are rejected.
- Identical decisions are idempotent; conflicting decisions are rejected.

### Runtime orchestration

- A valid spec result prompts Supervisor review rather than immediately
  permitting review-merge.
- Supervisor rejection causes a corrective spec worker attempt with the reason
  in context.
- Supervisor approval unlocks review-merge for the identified attempt only.
- A newer attempt invalidates the prior approval.
- Approval alone does not transition the change to `executing`.
- Successful merge plus post-merge validation transitions to `executing`.
- Failed merge or post-merge validation leaves the change `specifying`.

### Persistence and restart

- Approvals and rejections survive process restart.
- Rehydration does not invent approval from older success or merge events.
- Duplicate event replay remains idempotent.

### UI and configuration

- Provider Setup no longer renders a Spec writer assignment.
- Worker, review-merge, and integrator assignments continue to function.
- Fresh settings serialization cannot emit `roleAssignments.spec_writer`.

### Regression

- Small goals without change plans retain the flat worker flow.
- Non-spec worker review and delivery behavior is unchanged.
- Existing OpenSpec pre-merge and post-merge structural validation remains
  enforced.

## Risks and Deferred Work

Without SHA binding, approval identifies a worker attempt rather than an
immutable tree. The design relies on the existing lifecycle expectation that a
completed worker no longer mutates its worktree. A later change may create the
candidate commit before Supervisor review and bind Supervisor approval,
review-merge, and delivery to the same SHA.

The Supervisor receives a bounded artifact summary rather than necessarily the
full spec. If live evaluation shows that summaries omit decision-critical
details, the review packet will need a deterministic diff or artifact-content
projection. This design does not silently treat incomplete context as approval;
the Supervisor may reject and request clarification.

## Acceptance Criteria

The change is complete when:

1. No configurable or runtime `spec_writer` identity remains.
2. Spec authoring continues through a normal worker task and worktree.
3. A structurally valid spec cannot be review-merged before Supervisor
   approval.
4. Approval and rejection target the latest worker attempt and survive restart.
5. Only successful review-merge plus post-merge validation advances the change
   to `executing`.
6. The current development SQLite data has been fully reset and an empty
   current-schema database can start normally.
7. Typecheck and the relevant domain, runtime, persistence, UI, and regression
   tests pass.
