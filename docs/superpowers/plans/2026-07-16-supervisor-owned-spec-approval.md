# Supervisor-Owned Spec Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dormant `spec_writer` identity with worker-authored specs that require a durable Supervisor semantic approval before review-merge.

**Architecture:** Spec authoring remains a `worker` delegation selected by the `spec:<changeId>` task ID. A per-change in-memory gate, reconstructed from durable events, tracks the latest structurally valid worker attempt and the Supervisor's `approve` or `reject` decision; the session manager rejects spec review-merge until that exact attempt is approved. Backend S1-S3 validation runs before the Supervisor sees a bounded artifact packet and again after merge.

**Tech Stack:** TypeScript, Node.js test runner, React server rendering tests, SQLite via `better-sqlite3`, Git worktrees, OpenSpec markdown artifacts.

## Global Constraints

- `spec_writer` is not an assignable or runtime role; spec and implementation agents both use `worker` in separate sessions.
- Supervisor approval is `approve | reject` plus a required summary and is bound to `workerDelegationRequestId`, not to a Git SHA.
- A new spec attempt invalidates the prior attempt's approval for gating purposes.
- Approval unlocks review-merge only; only merge plus post-merge validation advances the change to `executing`.
- Preserve S1-S3 pre-merge and post-merge structural validation.
- Do not add legacy `spec_writer` parsing or data migration.
- Remove all current development SQLite data and stop tracking the populated database file.
- Preserve non-spec worker, review-merge, integrator, and flat-goal behavior.

---

## File Map

- `src/domain/agent-runtime-control-plane.types.ts`: public control-event type and union.
- `src/domain/index.ts`: public export for the new event type.
- `src/runtime/agent-session/delegation-control-event.ts`: syntax validation for Supervisor spec decisions.
- `src/runtime/agent-session/change-registry.ts`: latest validated attempt, durable decision state, idempotency, and approval gate.
- `src/runtime/agent-session/supervisor-state-rehydration.ts`: replay spec-review events after restart.
- `src/runtime/agent-session/spec-review-packet.ts`: bounded, deterministic projection of authored OpenSpec markdown.
- `src/runtime/agent-session/supervisor-prompt.ts`: Supervisor ownership rules and control-block example.
- `src/runtime/agent-session/agent-session-manager.ts`: pre-review validation, decision handling, review gate, and post-merge transition.
- `src/domain/provider-settings.types.ts`, `src/dashboard/api.ts`, `src/dashboard/ProviderSetup.tsx`, `src/backend/routes/provider-settings.ts`: remove the configurable identity.
- `README.md`: document the worker-authored/Supervisor-approved flow and remaining assignable roles.
- `.gitignore`, `data/auto-agent.sqlite`: reset and untrack local development state.
- Matching `*.test.ts` and `*.test.tsx` files: focused red/green coverage for every boundary.

---

### Task 1: Define and Parse the Supervisor Spec-Review Control Event

**Files:**
- Modify: `src/domain/agent-runtime-control-plane.types.ts`
- Modify: `src/domain/index.ts`
- Modify: `src/runtime/agent-session/delegation-control-event.ts`
- Test: `src/domain/agent-runtime-control-plane.types.test.ts`
- Test: `src/runtime/agent-session/delegation-control-event.test.ts`

**Interfaces:**
- Produces: `ManagedSpecReviewControlEvent`.
- Produces: validation result `{ ok: true; kind: "spec_review"; review: ManagedSpecReviewControlEvent }`.
- Consumes later: `agent-session-manager.ts` handles the stateful decision after syntax validation.

- [ ] **Step 1: Add failing domain and validator tests**

Add a domain fixture proving the new event belongs to `ManagedControlEvent`, and add table-driven validator assertions:

```ts
test("validates a Supervisor spec review control event", () => {
  assert.deepEqual(validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.spec_review",
      changeId: "change-one",
      workerDelegationRequestId: "worker-1",
      decision: "approve",
      summary: "The spec is semantically sufficient.",
    },
    parentSession: supervisorSession(),
  }), {
    ok: true,
    kind: "spec_review",
    review: {
      type: "managed_change.spec_review",
      changeId: "change-one",
      workerDelegationRequestId: "worker-1",
      decision: "approve",
      summary: "The spec is semantically sufficient.",
    },
  });
});

test("rejects malformed Supervisor spec reviews", () => {
  for (const controlEvent of [
    { type: "managed_change.spec_review", changeId: "", workerDelegationRequestId: "worker-1", decision: "approve", summary: "ok" },
    { type: "managed_change.spec_review", changeId: "change-one", workerDelegationRequestId: "", decision: "approve", summary: "ok" },
    { type: "managed_change.spec_review", changeId: "change-one", workerDelegationRequestId: "worker-1", decision: "maybe", summary: "ok" },
    { type: "managed_change.spec_review", changeId: "change-one", workerDelegationRequestId: "worker-1", decision: "reject", summary: "" },
  ]) {
    assert.equal(validateManagedControlEvent({ controlEvent, parentSession: supervisorSession() }).ok, false);
  }
});
```

- [ ] **Step 2: Run the focused tests and observe the red state**

Run:

```powershell
node --import tsx --test src/domain/agent-runtime-control-plane.types.test.ts src/runtime/agent-session/delegation-control-event.test.ts
```

Expected: FAIL because `managed_change.spec_review` is unsupported and `ManagedSpecReviewControlEvent` is absent.

- [ ] **Step 3: Add the event type and pure syntax validator**

Add this interface and union member:

```ts
export interface ManagedSpecReviewControlEvent {
  type: "managed_change.spec_review";
  changeId: string;
  workerDelegationRequestId: string;
  decision: "approve" | "reject";
  summary: string;
}
```

Add `managed_change.spec_review` to `managedControlEventTypes`, export the interface through `src/domain/index.ts`, and extend `ManagedControlEventValidationResult` with `kind: "spec_review"`. Implement a private validator that trims all strings, permits only `approve` and `reject`, and returns stable safe reasons for the four malformed cases.

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```powershell
node --import tsx --test src/domain/agent-runtime-control-plane.types.test.ts src/runtime/agent-session/delegation-control-event.test.ts
npm run typecheck
```

Expected: all selected tests pass and `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit the control-event contract**

```powershell
git add src/domain/agent-runtime-control-plane.types.ts src/domain/index.ts src/domain/agent-runtime-control-plane.types.test.ts src/runtime/agent-session/delegation-control-event.ts src/runtime/agent-session/delegation-control-event.test.ts
git commit -m "feat: define supervisor spec review event"
```

---

### Task 2: Add Attempt-Bound Approval State and Restart Rehydration

**Files:**
- Modify: `src/runtime/agent-session/change-registry.ts`
- Modify: `src/runtime/agent-session/supervisor-state-rehydration.ts`
- Test: `src/runtime/agent-session/change-registry.test.ts`
- Test: `src/runtime/agent-session/supervisor-state-rehydration.test.ts`
- Test: `src/runtime/agent-session/supervisor-prompt.test.ts`

**Interfaces:**
- Produces: `SpecReviewState` on every `ChangeRecord`.
- Produces: `markSpecReadyForReview(changeId, workerDelegationRequestId)`.
- Produces: `recordSpecReview(input): RegistryGate & { duplicate?: boolean }`.
- Produces: `gateSpecReviewMerge(changeId, workerDelegationRequestId): RegistryGate`.
- Produces: `markSpecMerged(changeId)` for the post-merge transition.

- [ ] **Step 1: Write failing registry tests for current, stale, duplicate, and conflicting decisions**

Cover the complete state contract:

```ts
registry.markSpecReadyForReview("change-one", "worker-1");
assert.deepEqual(registry.gateSpecReviewMerge("change-one", "worker-1"), {
  ok: false,
  safeReason: "Spec attempt worker-1 requires Supervisor approval before review-merge.",
});
assert.deepEqual(registry.recordSpecReview({
  changeId: "change-one",
  workerDelegationRequestId: "worker-1",
  decision: "approve",
  summary: "Semantically sufficient.",
}), { ok: true, duplicate: false });
assert.deepEqual(registry.gateSpecReviewMerge("change-one", "worker-1"), { ok: true });
assert.deepEqual(registry.recordSpecReview({
  changeId: "change-one",
  workerDelegationRequestId: "worker-1",
  decision: "approve",
  summary: "Semantically sufficient.",
}), { ok: true, duplicate: true });
```

Also assert that rejection does not unlock review, a changed summary or decision for an already reviewed attempt is rejected, `worker-0` is stale, inactive changes are rejected, and `markSpecReadyForReview("change-one", "worker-2")` clears the `worker-1` approval.

- [ ] **Step 2: Run the registry tests and observe the red state**

Run:

```powershell
node --import tsx --test src/runtime/agent-session/change-registry.test.ts
```

Expected: FAIL because the spec-review state and methods do not exist.

- [ ] **Step 3: Implement the registry state machine**

Add these types and initialize them in `registerPlan`:

```ts
export interface SpecReviewState {
  validatedWorkerDelegationRequestId: string | null;
  reviewedWorkerDelegationRequestId: string | null;
  decision: "approve" | "reject" | null;
  summary: string | null;
}

export interface ChangeRecord {
  // existing fields
  specReview: SpecReviewState;
}

const emptySpecReview = (): SpecReviewState => ({
  validatedWorkerDelegationRequestId: null,
  reviewedWorkerDelegationRequestId: null,
  decision: null,
  summary: null,
});
```

Implement the four interfaces named above. Rename the existing transition-only `markSpecApproved` method to `markSpecMerged`; Supervisor approval must only update `specReview`, while `markSpecMerged` changes `specifying` to `executing`.

- [ ] **Step 4: Add failing rehydration coverage**

Replay these events in order and assert the reconstructed gate is open only for `worker-2`:

```ts
change.spec_review_requested(worker-1)
change.spec_supervisor_approved(worker-1)
change.spec_review_requested(worker-2)
change.spec_supervisor_approved(worker-2)
```

Then replay `change.spec_merged` and assert the change becomes `executing`. Add the new `specReview` property to prompt history fixtures and assert `renderChangeHistory` identifies `awaiting Supervisor approval`, `approved`, or `rejected` without changing the managed change status.

- [ ] **Step 5: Implement durable event replay and prompt-state rendering**

In `rehydrateChangeRegistry`, map:

```ts
change.spec_review_requested -> markSpecReadyForReview(changeId, workerDelegationRequestId)
change.spec_supervisor_approved -> recordSpecReview({ decision: "approve", ... })
change.spec_supervisor_rejected -> recordSpecReview({ decision: "reject", ... })
change.spec_merged -> markSpecMerged(changeId)
```

Ignore malformed historic events rather than throwing during restart. Do not replay the old `change.spec_approved` name because the database will be reset.

- [ ] **Step 6: Run registry, rehydration, prompt, and type tests**

Run:

```powershell
node --import tsx --test src/runtime/agent-session/change-registry.test.ts src/runtime/agent-session/supervisor-state-rehydration.test.ts src/runtime/agent-session/supervisor-prompt.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the durable approval state**

```powershell
git add src/runtime/agent-session/change-registry.ts src/runtime/agent-session/change-registry.test.ts src/runtime/agent-session/supervisor-state-rehydration.ts src/runtime/agent-session/supervisor-state-rehydration.test.ts src/runtime/agent-session/supervisor-prompt.test.ts
git commit -m "feat: track durable spec approvals"
```

---

### Task 3: Build the Bounded Spec Review Packet and Supervisor Instructions

**Files:**
- Create: `src/runtime/agent-session/spec-review-packet.ts`
- Create: `src/runtime/agent-session/spec-review-packet.test.ts`
- Modify: `src/runtime/agent-session/supervisor-prompt.ts`
- Test: `src/runtime/agent-session/supervisor-prompt.test.ts`

**Interfaces:**
- Produces: `buildSpecReviewPacket(input: { cwd: string; changeId: string; maxChars?: number }): string`.
- Renames: `buildSpecWriterAppendix` to `buildSpecAuthoringAppendix` and `SpecWriterChangeContext` to `SpecAuthoringChangeContext`.
- Extends: `SpecAuthoringChangeContext` with `supervisorFeedback?: string | null` for corrective attempts.
- Consumes later: `agent-session-manager.ts` appends the packet to the continuation after structural validation succeeds.

- [ ] **Step 1: Write failing packet tests**

Create a temporary OpenSpec change containing `proposal.md`, two nested `spec.md` files, and `tasks.md`. Assert deterministic order, Markdown file headings, omission of non-Markdown files, and a stable truncation marker when `maxChars` is small:

```ts
const packet = buildSpecReviewPacket({ cwd, changeId: "change-one" });
assert.ok(packet.indexOf("proposal.md") < packet.indexOf("specs/core/spec.md"));
assert.ok(packet.indexOf("specs/core/spec.md") < packet.indexOf("tasks.md"));
assert.match(packet, /## File: proposal\.md/);
assert.doesNotMatch(packet, /ignored\.json/);
assert.match(buildSpecReviewPacket({ cwd, changeId: "change-one", maxChars: 180 }), /\[review packet truncated\]$/);
```

- [ ] **Step 2: Run the packet test and observe the red state**

Run:

```powershell
node --import tsx --test src/runtime/agent-session/spec-review-packet.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic, bounded artifact projection**

Implement the helper with these exact rules:

```ts
const DEFAULT_MAX_CHARS = 12_000;
const TRUNCATION_MARKER = "\n\n[review packet truncated]";

export function buildSpecReviewPacket(input: {
  cwd: string;
  changeId: string;
  maxChars?: number;
}): string {
  const root = resolve(input.cwd, "openspec", "changes", input.changeId);
  const relativeFiles = [
    "proposal.md",
    ...listMarkdownFiles(resolve(root, "specs")).map((path) => relative(root, path).replaceAll("\\", "/")),
    "tasks.md",
  ];
  const body = relativeFiles
    .filter((path) => existsSync(resolve(root, path)))
    .map((path) => `## File: ${path}\n\n${readFileSync(resolve(root, path), "utf8").trim()}`)
    .join("\n\n");
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  return body.length <= maxChars
    ? body
    : `${body.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}
```

`listMarkdownFiles` must recursively traverse existing directories, include only regular `.md` files, normalize paths, and sort them lexically before returning.

- [ ] **Step 4: Add failing prompt-contract assertions**

Assert that the Supervisor contract:

- calls spec authoring a worker task, not a `spec_writer` role;
- requires `managed_change.spec_review` after a structurally valid spec result;
- prohibits review-merge before approval;
- contains an approve/reject example with `workerDelegationRequestId`;
- does not mention `candidateCommitSha` in that example.

- [ ] **Step 5: Update the Supervisor prompt contract**

Insert this control example before the review-merge example and update the numbered rules:

```ts
controlExample({
  type: "managed_change.spec_review",
  changeId: "core-loop",
  workerDelegationRequestId: "<spec worker delegation request id>",
  decision: "approve",
  summary: "The authored specification preserves the intended scope and is ready for independent review.",
})
```

State explicitly that rejection must explain the required semantic revision and that approval only unlocks review-merge.

Rename the appendix symbols so task specialization is not represented as an agent identity, and append durable corrective feedback when present:

```ts
export interface SpecAuthoringChangeContext {
  id: string;
  title: string;
  rationale: string;
  dependsOn: string[];
  supervisorFeedback?: string | null;
}
```

Preserve the current return-array entries while changing the exported names, then insert this exact spread immediately before the array's `.join("\n")`:

```ts
...(change.supervisorFeedback
  ? ["", "## Supervisor revision request", "", change.supervisorFeedback]
  : []),
```

Add a test proving an initial attempt has no revision section and a rejected attempt includes the exact durable summary.

- [ ] **Step 6: Run packet and prompt tests**

Run:

```powershell
node --import tsx --test src/runtime/agent-session/spec-review-packet.test.ts src/runtime/agent-session/supervisor-prompt.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the review packet and prompt contract**

```powershell
git add src/runtime/agent-session/spec-review-packet.ts src/runtime/agent-session/spec-review-packet.test.ts src/runtime/agent-session/supervisor-prompt.ts src/runtime/agent-session/supervisor-prompt.test.ts
git commit -m "feat: present specs for supervisor approval"
```

---

### Task 4: Validate Spec Results and Record Supervisor Decisions

**Files:**
- Modify: `src/runtime/agent-session/agent-session-manager.ts`
- Test: `src/runtime/agent-session/agent-session-manager.test.ts`

**Interfaces:**
- Consumes: `buildSpecReviewPacket`, registry `markSpecReadyForReview`, and validated `kind: "spec_review"`.
- Produces durable events: `change.spec_review_requested`, `change.spec_supervisor_approved`, `change.spec_supervisor_rejected`.
- Produces rejection transition: durable task `awaiting_review -> rejected`; non-durable task becomes redispatchable under its existing attempt budget.

- [ ] **Step 1: Write a failing production-path structural-validation test**

Create the manager with a real `managedTaskRepo`, emit a successful result for `spec:change-one`, and configure `validateChange` to fail. Assert:

```ts
assert.equal(managedTaskRepo.getTask(goalId, "spec:change-one")?.status, "rejected");
assert.ok(events.some((event) => event.data.runtimeEventType === "task.rejection_recorded"));
assert.ok(!events.some((event) => event.data.runtimeEventType === "change.spec_review_requested"));
```

This test must fail before implementation, proving the durable path currently skips the pre-review spec gate.

- [ ] **Step 2: Apply pre-review validation in both durable and non-durable paths**

Keep the non-durable call to `rejectInvalidSpecResult` before `registry.recordOutcome`. In `recordDurableChildOutcome`, first call `recordExecutorEvidence` so the existing legal transition moves the task from `delegated` to `awaiting_review`; then call `rejectInvalidSpecResult`. When validation fails, transition the durable task from `awaiting_review` to `rejected` with the S1-S3 summary and return before recording `change.spec_review_requested`. This ordering reuses the repository's current transition table and still prevents any Supervisor review of invalid artifacts.

- [ ] **Step 3: Write failing tests for a valid review request and both decisions**

For a valid spec result, assert the continuation contains the bounded packet and a `change.spec_review_requested` event containing `changeId`, `taskId`, and `workerDelegationRequestId`. Then emit approve and reject control blocks in separate fixtures and assert:

```ts
assert.equal(approved.data.runtimeEventType, "change.spec_supervisor_approved");
assert.equal(approved.data.workerDelegationRequestId, specWorkerRequestId);
assert.equal(rejected.data.runtimeEventType, "change.spec_supervisor_rejected");
assert.equal(managedTaskRepo.getTask(goalId, "spec:change-one")?.status, "rejected");
```

Add stale-attempt, inactive-change, unvalidated-attempt, malformed-event, identical duplicate, and conflicting duplicate assertions. Each rejected control event must use the existing `delegation.rejected` mechanism and leave prior state unchanged.

- [ ] **Step 4: Record the review request and packet after successful validation**

Add a helper with this responsibility:

```ts
function recordSpecReviewRequested(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  outcome: SupervisorContinuationInput,
): string | null
```

For a spec task, call `markSpecReadyForReview(change.id, outcome.delegationRequestId)`, emit `change.spec_review_requested`, and return a continuation appendix containing the change ID, worker request ID, successful S1-S3 result, and `buildSpecReviewPacket(...)`. Return `null` for non-spec tasks.

- [ ] **Step 5: Handle the stateful Supervisor decision**

Add a `validation.kind === "spec_review"` branch before delegation handling. Call `recordSpecReview`, persist exactly one approved/rejected event for a non-duplicate result, and return without spawning a child. For rejection:

```ts
deps.managedTaskRepo?.transition(specTaskId(review.changeId), "rejected", {
  goalId: input.goalId,
  runId: input.runId,
  safeSummary: review.summary,
});
getTaskRegistry(input.state, input.goalId).markFailed(specTaskId(review.changeId));
```

Do not transition the task on approval; it must remain reviewable. Feed registry safe reasons through `recordControlRejection`.

When the same spec task is delegated again after rejection, call `buildSpecAuthoringAppendix` with `supervisorFeedback: specChange.specReview.summary`. Add a manager assertion that the corrective worker prompt contains the exact rejected summary; this makes revision feedback deterministic rather than relying on the Supervisor to repeat it.

- [ ] **Step 6: Run focused manager tests and typecheck**

Run:

```powershell
node --import tsx --test --test-name-pattern="spec" src/runtime/agent-session/agent-session-manager.test.ts
npm run typecheck
```

Expected: all spec-focused manager tests pass and typecheck exits 0.

- [ ] **Step 7: Commit result validation and Supervisor decisions**

```powershell
git add src/runtime/agent-session/agent-session-manager.ts src/runtime/agent-session/agent-session-manager.test.ts
git commit -m "feat: require supervisor spec decisions"
```

---

### Task 5: Gate Review-Merge and Advance Only After Merged Validation

**Files:**
- Modify: `src/runtime/agent-session/agent-session-manager.ts`
- Test: `src/runtime/agent-session/agent-session-manager.test.ts`
- Test: `src/runtime/agent-session/supervisor-state-rehydration.test.ts`

**Interfaces:**
- Consumes: registry `gateSpecReviewMerge` and `markSpecMerged`.
- Produces: `change.spec_merged` only after delivery reports `merged` and post-merge `validateChange` succeeds.

- [ ] **Step 1: Write failing review-gate tests**

Exercise review-merge requests that reference:

- a valid but unapproved spec attempt: rejected;
- a Supervisor-rejected attempt: rejected;
- an older approved attempt after a new valid attempt exists: rejected;
- the latest approved attempt: accepted and starts one `review_merge` child;
- a non-spec worker attempt: unchanged existing behavior.

Assert the safe reason includes both the spec task and the required Supervisor action.

- [ ] **Step 2: Run the review-gate tests and observe the red state**

Run:

```powershell
node --import tsx --test --test-name-pattern="Supervisor approval|spec review-merge" src/runtime/agent-session/agent-session-manager.test.ts
```

Expected: FAIL because review-merge currently starts without Supervisor approval.

- [ ] **Step 3: Gate spec review-merge before child-agent resolution**

When `validation.request.role === "review_merge"`, reload the referenced worker delegation with `findDelegationForGoal`. If its `taskId` is a registered spec task, call:

```ts
const gate = changeRegistry.gateSpecReviewMerge(change.id, validation.request.workerDelegationRequestId!);
if (!gate.ok) {
  recordControlRejection(deps, input, data, gate.safeReason);
  return;
}
```

Do this before `resolveChildAgent` and before `acceptAndStartWorker` so a rejected request creates no child session.

- [ ] **Step 4: Write failing post-merge transition tests**

Assert Supervisor approval alone leaves the change `specifying`; merge with failed goal-workspace validation also leaves it `specifying`; only merged delivery plus successful post-merge validation emits `change.spec_merged` and changes status to `executing`.

- [ ] **Step 5: Rename and narrow the post-merge transition**

Rename `approveSpecChangeAfterMerge` to `completeSpecMergeAfterValidation`, call `markSpecMerged`, and emit:

```ts
{
  runtimeEventType: "change.spec_merged",
  changeId: change.id,
  workerDelegationRequestId,
}
```

Pass `workerDelegationRequestId` into the helper and verify it is the currently approved attempt before transitioning. Remove the ambiguous `change.spec_approved` runtime event and update rehydration and test expectations to `change.spec_merged`.

- [ ] **Step 6: Run manager, rehydration, and full runtime tests**

Run:

```powershell
node --import tsx --test src/runtime/agent-session/agent-session-manager.test.ts src/runtime/agent-session/supervisor-state-rehydration.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the enforced gate**

```powershell
git add src/runtime/agent-session/agent-session-manager.ts src/runtime/agent-session/agent-session-manager.test.ts src/runtime/agent-session/supervisor-state-rehydration.test.ts
git commit -m "feat: gate spec merge on supervisor approval"
```

---

### Task 6: Remove the Dormant `spec_writer` Assignment Surface

**Files:**
- Modify: `src/domain/provider-settings.types.ts`
- Modify: `src/domain/provider-settings.test.ts`
- Modify: `src/dashboard/api.ts`
- Modify: `src/dashboard/ProviderSetup.tsx`
- Modify: `src/dashboard/ProviderSetup.test.tsx`
- Modify: `src/backend/role-adapter-resolver.test.ts`
- Modify: `src/backend/api.test.ts`
- Modify: `README.md`

**Interfaces:**
- Changes: `AgentAssignableRole` becomes `"worker" | "review_merge" | "integrator"`.
- Preserves: role resolution and UI assignment for those three roles.

- [ ] **Step 1: Change tests first to require the reduced role surface**

Update the domain expectation:

```ts
assert.deepEqual(agentAssignableRoles, ["worker", "review_merge", "integrator"]);
```

Update the UI test to assert `Spec writer` is absent while the other three labels remain. Replace resolver coverage for `spec_writer` with `review_merge`. Add an API test that posting a `roleAssignments.spec_writer` entry returns HTTP 400 with `unknown role: spec_writer`.

- [ ] **Step 2: Run focused role tests and observe the red state**

Run:

```powershell
node --import tsx --test src/domain/provider-settings.test.ts src/backend/role-adapter-resolver.test.ts src/backend/api.test.ts src/dashboard/ProviderSetup.test.tsx
```

Expected: FAIL because `spec_writer` is still exported, rendered, and accepted.

- [ ] **Step 3: Remove the role from shared lists and UI labels**

Set both domain and dashboard arrays to:

```ts
export const agentAssignableRoles = ["worker", "review_merge", "integrator"] as const;
```

Delete `spec_writer: "Spec writer"` from `roleDisplayNames`. The existing backend parser will then reject it because it checks the shared domain list. Keep `RoleAssignments` generic over the reduced union; do not add compatibility parsing.

- [ ] **Step 4: Update documentation terminology**

Document that provider setup assigns `worker`, `review_merge`, and conditional `integrator`. Replace "Spec-writer workers" with "Spec-authoring workers" and state that the Supervisor semantically approves a structurally valid attempt before review-merge.

- [ ] **Step 5: Run focused role tests, README search, and typecheck**

Run:

```powershell
node --import tsx --test src/domain/provider-settings.test.ts src/backend/role-adapter-resolver.test.ts src/backend/api.test.ts src/dashboard/ProviderSetup.test.tsx
rg -n "spec_writer|Spec writer" README.md src
npm run typecheck
```

Expected: selected tests pass; `rg` returns no production/UI/documentation references to the removed identity (test assertions rejecting the literal may remain); typecheck exits 0.

- [ ] **Step 6: Commit the role cleanup**

```powershell
git add src/domain/provider-settings.types.ts src/domain/provider-settings.test.ts src/dashboard/api.ts src/dashboard/ProviderSetup.tsx src/dashboard/ProviderSetup.test.tsx src/backend/role-adapter-resolver.test.ts src/backend/api.test.ts README.md
git commit -m "refactor: remove spec writer role assignment"
```

---

### Task 7: Reset Development SQLite State and Run Final Verification

**Files:**
- Modify: `.gitignore`
- Delete: `data/auto-agent.sqlite`
- Test: `src/persistence/database.test.ts`
- Verify: all files changed by Tasks 1-6

**Interfaces:**
- Preserves: `openDatabase()` recreates the default directory and current schema on demand.
- Changes: local SQLite database files are ignored and no populated database is committed.

- [ ] **Step 1: Add a database recreation assertion**

Extend the existing temp-database test to open a nonexistent nested path, assert core tables such as `goals`, `events`, `provider_settings`, and `managed_tasks` exist, and assert every application table starts empty:

```ts
const counts = ["goals", "events", "provider_settings", "managed_tasks"].map((table) =>
  db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number },
);
assert.deepEqual(counts.map(({ count }) => count), [0, 0, 0, 0]);
```

- [ ] **Step 2: Run the database test before resetting the real development file**

Run:

```powershell
node --import tsx --test src/persistence/database.test.ts
```

Expected: all database tests pass, proving an empty database can be recreated before destructive cleanup.

- [ ] **Step 3: Stop tracking SQLite state and remove the authorized development data**

Add these entries to `.gitignore`:

```gitignore
data/*.sqlite
data/*.sqlite-shm
data/*.sqlite-wal
```

Verify the resolved path and remove only the authorized file:

```powershell
$expected = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) 'data\auto-agent.sqlite'))
$actual = (Resolve-Path -LiteralPath 'data\auto-agent.sqlite').Path
if ($actual -ne $expected) { throw "Refusing to remove unexpected database path: $actual" }
git rm -- 'data/auto-agent.sqlite'
```

- [ ] **Step 4: Smoke-test recreation at the default path**

Run:

```powershell
node --import tsx -e "import { openDatabase } from './src/persistence/database.ts'; const db=openDatabase(); const count=db.prepare('SELECT COUNT(*) AS count FROM goals').get(); console.log(JSON.stringify(count)); db.close();"
```

Expected output:

```text
{"count":0}
```

Confirm the recreated file is ignored with `git status --ignored --short data` and then remove that ignored smoke-test file from the working directory using the same resolved-path guard and `Remove-Item -LiteralPath`.

- [ ] **Step 5: Run complete verification**

Run:

```powershell
npm run typecheck
npm test
git diff --check
```

Expected: typecheck exits 0; the complete test run reports zero failures; `git diff --check` emits no errors.

- [ ] **Step 6: Verify acceptance criteria from observable state**

Run:

```powershell
rg -n "spec_writer|Spec writer" README.md src
git ls-files 'data/*.sqlite*'
git status --short
```

Expected: no production identity references, no tracked SQLite files, and only Task 7's intended `.gitignore`, database deletion, and database-test changes are uncommitted.

- [ ] **Step 7: Commit the database reset and final regression proof**

```powershell
git add .gitignore src/persistence/database.test.ts
git add -u -- data/auto-agent.sqlite
git commit -m "chore: reset development sqlite state"
```
