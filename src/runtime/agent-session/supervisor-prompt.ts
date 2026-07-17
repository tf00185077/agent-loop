import type { AgentRuntimeDelegationSummary, TaskAcceptanceCriterion } from "../../domain/index.js";
import type { ChangeRecord, EpochRecord } from "./change-registry.js";
import type { TaskRecord } from "./task-registry.js";
import type { ManagedTaskContextRecord } from "./managed-context-projection.js";

export interface SupervisorPromptGoal {
  title: string;
  description: string;
}

export type SupervisorPromptPhase =
  | { kind: "bootstrap" }
  | { kind: "continuation"; observation: string }
  | { kind: "nudge" }
  | { kind: "rejection"; safeReason: string };

export interface BuildSupervisorPromptInput {
  goal: SupervisorPromptGoal;
  phase: SupervisorPromptPhase;
  /** Durable task history rendered into continuation/nudge/rejection prompts. */
  taskHistory?: TaskRecord[];
  managedTaskContext?: ManagedTaskContextRecord[];
  /** Durable change-plan state rendered into continuation/nudge/rejection prompts. */
  changeHistory?: ChangeRecord[];
  /** Planning-epoch metadata grouping the change history. */
  epochHistory?: EpochRecord[];
}

const fence = "```";

function controlExample(payload: Record<string, unknown>): string {
  return [`${fence}auto-agent-control`, JSON.stringify(payload, null, 2), fence].join("\n");
}

const CONTRACT = [
  "## How you work",
  "",
  "You are the supervisor for this goal. You do not edit files or run commands",
  "yourself; you delegate implementation work to child agents and judge their",
  "results.",
  "",
  "Rules:",
  "0. Assess the goal's scale before anything else. If it is too large for one",
  "   flat task list (several distinct deliverables or proof obligations that",
  "   later work must not contradict), declare an ordered change plan with a",
  "   `managed_change.plan` control block: 1–8 changes, unique ids, and",
  "   optional acyclic `dependsOn` references. The backend scaffolds each",
  "   change's OpenSpec artifacts and registers one spec-authoring task per",
  "   change (`spec:<changeId>`) that you delegate like any worker task; a",
  "   change's implementation tasks run only after its specs are merged, one",
  "   change at a time. Do NOT try to predict all future work in the first",
  "   plan: declare only the batch you can justify now — later batches come",
  "   from the reassessment loop in rule 5. Small goals skip the plan entirely",
  "   and keep the flat task-list flow below.",
  "   Synthetic `spec:<changeId>` tasks are already registered with",
  "   backend-authored frozen criteria when the plan is accepted. Later task",
  "   lists announce implementation tasks only; do not re-announce synthetic `spec:`",
  "   tasks or restate their acceptance criteria.",
  "1. Decompose the work into an ordered task list and announce it with a",
  "   `managed_delegation.task_list` control block before delegating anything.",
  "   Every task MUST include acceptance criteria: an immutable id (A1, A2, ...)",
  "   and one binary, testable condition each. Delegating a task without",
  "   acceptance criteria is rejected by the backend.",
  "   Where a criterion can be proven by a command, attach an executable",
  "   `check`: kind `red_green` (the backend runs it on the baseline too and",
  "   rejects checks that already pass there — author tests that fail before",
  "   the change and pass after), `regression` (must stay green on baseline",
  "   and candidate), or `command` (candidate only). List the test files in",
  "   `protectedPaths`; the worker cannot modify them. The backend executes",
  "   checks itself at review time and their results outrank judge prose.",
  "2. Acceptance criterion ids are frozen once announced. To reject a worker",
  "   result, cite the failing criterion ids explicitly (for example: A2 fails",
  "   because ...). Objections that cite no criterion id are recorded as",
  "   deferred findings and do not block the task. After two cited rejections",
  "   the backend refuses identical retries: split the failing criteria into",
  "   strictly narrower tasks (fewer criteria, with parentTaskId set).",
  "3. Delegate exactly one worker task at a time with a `managed_delegation.request`",
  "   control block (role `worker`). Wait for its result before the next delegation.",
  "4. After a structurally valid spec authoring result, the backend presents a",
  "   bounded review packet. Judge the spec's CONTENT against the change's",
  "   intent and emit a `managed_change.spec_review` decision bound to that",
  "   worker attempt id. A rejection must explain the required semantic",
  "   revision; it is delivered verbatim to the corrective attempt. Approval",
  "   only unlocks review-merge — the backend rejects a spec review-merge",
  "   without your approval, and dispatching a new spec attempt voids any",
  "   earlier approval.",
  "5. After worker results that changed files, request a review-merge child",
  "   (role `review_merge`, referencing the worker delegation request id you were",
  "   given) before treating the task as delivered.",
  "6. Planned goals loop in epochs. After every change of the current batch is",
  "   archived or blocked, re-read the ORIGINAL goal against the delivered",
  "   evidence and emit a `managed_goal.reassessment` control block with your",
  "   structured judgment. Each remaining gap is an object with `refs` (each a",
  "   change id, a registered task id, an openspec/specs capability name, or",
  "   `new:<kebab-case>` for new scope) and a prose `summary`; blocked changes",
  "   must be referenced so their scope is re-planned. If gaps remain",
  "   (`goalSatisfied: false`), follow with a new `managed_change.plan` for the",
  "   next batch (new unique change ids) derived from what execution actually",
  "   revealed. The backend rejects next-batch plans without an unsatisfied",
  "   reassessment, and blocks the goal when the epoch budget is exhausted or",
  "   consecutive reassessments repeat the same gap refs.",
  "7. When every task is delivered — and, for planned goals, the latest",
  "   reassessment is satisfied — emit a `managed_delegation.complete` control",
  "   block with a short result summary. The goal only completes when you emit it.",
  "8. Only fenced `auto-agent-control` blocks are honored as control signals;",
  "   anything else is treated as progress commentary.",
  "",
  "Control block formats (one JSON object per fenced block):",
  "",
  controlExample({
    type: "managed_change.plan",
    changes: [
      {
        id: "core-loop",
        title: "Core gameplay loop",
        rationale: "Everything else builds on the playable loop.",
      },
      {
        id: "multiplayer-modes",
        title: "4v4 and co-op modes",
        rationale: "Modes extend the core loop and must not contradict it.",
        dependsOn: ["core-loop"],
      },
    ],
  }),
  "",
  controlExample({
    type: "managed_delegation.task_list",
    tasks: [
      {
        id: "task-1",
        title: "First concrete task",
        acceptance: [
          {
            id: "A1",
            text: "Binary, testable condition for this task.",
            check: {
              kind: "red_green",
              command: "node --test tests/task-1.test.js",
              protectedPaths: ["tests/task-1.test.js"],
            },
          },
          { id: "A2", text: "Another binary, testable condition." },
        ],
      },
      {
        id: "task-2",
        title: "Second concrete task",
        acceptance: [{ id: "B1", text: "Binary, testable condition." }],
      },
    ],
  }),
  "",
  controlExample({
    type: "managed_delegation.request",
    role: "worker",
    taskId: "task-1",
    summary: "Short safe summary of the task",
    prompt: "Full, self-contained instructions for the child agent.",
  }),
  "",
  controlExample({
    type: "managed_change.spec_review",
    changeId: "core-loop",
    workerDelegationRequestId: "<spec worker delegation request id from the review request>",
    decision: "approve",
    summary: "The authored specification preserves the intended scope and is ready for independent review.",
  }),
  "",
  controlExample({
    type: "managed_delegation.request",
    role: "review_merge",
    workerDelegationRequestId: "<delegation request id from the worker result>",
    summary: "Independently judge the worker result",
    prompt: "Inspect the frozen criteria, evidence, and candidate diff; decide every criterion without applying or committing changes.",
  }),
  "",
  controlExample({
    type: "managed_goal.reassessment",
    goalSatisfied: false,
    evidence: ["What the archived changes verifiably delivered."],
    remainingGaps: [
      {
        refs: ["core-loop"],
        summary: "What the original goal still lacks, tied to the referenced artifacts.",
      },
    ],
    nextEpochRationale: "Why execution evidence justifies the next batch.",
  }),
  "",
  controlExample({
    type: "managed_delegation.complete",
    summary: "Short safe summary of what was delivered.",
  }),
].join("\n");

export function buildSupervisorPrompt(input: BuildSupervisorPromptInput): string {
  const sections = [phaseHeader(input.phase), goalSection(input.goal)];
  if (input.phase.kind !== "bootstrap" && input.changeHistory && input.changeHistory.length > 0) {
    sections.push(renderChangeHistory(input.changeHistory, input.epochHistory));
  }
  if (input.phase.kind !== "bootstrap" && input.managedTaskContext && input.managedTaskContext.length > 0) {
    sections.push(renderManagedTaskContext(input.managedTaskContext));
  } else if (input.phase.kind !== "bootstrap" && input.taskHistory && input.taskHistory.length > 0) {
    sections.push(renderTaskHistory(input.taskHistory));
  }
  sections.push(CONTRACT);
  return sections.join("\n\n");
}

/** Renders the durable change-plan state so continuations do not re-plan. */
export function renderChangeHistory(changes: ChangeRecord[], epochs?: EpochRecord[]): string {
  const active = changes.find((change) => change.status !== "archived" && change.status !== "blocked");
  const renderChange = (change: ChangeRecord) => {
    const dependsOn = change.dependsOn.length > 0 ? ` (depends on ${change.dependsOn.join(", ")})` : "";
    const activeMark = change.id === active?.id ? " (active — work here)" : "";
    return `- ${change.id} "${change.title}" [${change.status}]${dependsOn}${activeMark}`;
  };
  const lines = ["## Change plan (durable — one active change at a time; do not re-plan this epoch)", ""];
  if (epochs && epochs.length > 0) {
    for (const epoch of epochs) {
      const rationale = epoch.rationale ? ` — ${epoch.rationale}` : "";
      lines.push(`Epoch ${epoch.sequence}${rationale}:`);
      lines.push(...changes.filter((change) => change.epochSequence === epoch.sequence).map(renderChange));
    }
  } else {
    lines.push(...changes.map(renderChange));
  }
  return lines.join("\n");
}

/** Renders the durable per-task state so continuations do not re-derive it. */
export function renderTaskHistory(tasks: TaskRecord[]): string {
  const lines = [
    "## Task history (durable — do not re-announce existing tasks)",
    "",
    ...tasks.map((task) => {
      const criteria = task.acceptance
        ? task.acceptance
            .map((criterion) => `${criterion.id}: ${task.criterionOutcomes[criterion.id] ?? "unknown"}`)
            .join(", ")
        : "no criteria";
      const lineage = task.parentTaskId ? ` (split from ${task.parentTaskId})` : "";
      const rejections =
        task.substantiveRejections > 0
          ? `, rejections=${task.substantiveRejections} citing [${task.lastCitedCriteria.join(", ")}]`
          : "";
      const outcome = task.lastOutcomeSummary ? ` | last: ${task.lastOutcomeSummary}` : "";
      return `- ${task.id} "${task.title}"${lineage} [${task.status}] attempts=${task.attemptCount}${rejections} | ${criteria}${outcome}`;
    }),
  ];
  return lines.join("\n");
}

export function renderManagedTaskContext(tasks: ManagedTaskContextRecord[]): string {
  return [
    "## Task history (SQLite authority; prose claims do not override it)",
    "",
    ...tasks.map((task) => {
      const lineage = task.parentTaskId ? ` (child of ${task.parentTaskId})` : "";
      const criteria = task.criteria.length > 0
        ? task.criteria.map((criterion) => `${criterion.id}=${criterion.outcome}`).join(", ")
        : "no frozen criteria";
      const cited = task.lastCitedCriteria.length > 0 ? ` citing [${task.lastCitedCriteria.join(", ")}]` : "";
      const judge = task.lastJudgeVerdict ? ` judge=${task.lastJudgeVerdict}` : "";
      const delivery = task.lastDeliveryStatus ? ` delivery=${task.lastDeliveryStatus}` : "";
      const integration = task.lastIntegrationStatus
        ? ` integration=${task.lastIntegrationStatus}(${task.integrationAttemptId})` +
          (task.resolvedCandidateCommitSha ? ` candidate=${task.resolvedCandidateCommitSha}` : "")
        : "";
      const summary = task.lastSafeSummary ? ` | last: ${task.lastSafeSummary}` : "";
      return `- ${task.id} "${task.title}"${lineage} [${task.status}] attempts=${task.attemptCount} ` +
        `rejections=${task.substantiveRejectionCount}${cited} | ${criteria}${judge}${delivery}${integration}${summary}`;
    }),
  ].join("\n");
}

/**
 * Appendix appended to a worker child's prompt at dispatch: the frozen
 * acceptance contract and the structured-result reporting format.
 */
export function buildWorkerContractAppendix(acceptance: TaskAcceptanceCriterion[], taskId: string | null): string {
  return [
    "## Acceptance criteria (your result is judged only against these)",
    "",
    ...acceptance.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
    "",
    "When you finish, emit a fenced control block reporting evidence per",
    "criterion id, the tests you ran, and the files you changed:",
    "",
    controlExample({
      type: "managed_task.result",
      ...(taskId ? { taskId } : {}),
      criterionEvidence: acceptance.map((criterion) => ({
        criterionId: criterion.id,
        evidence: "How you verified this condition.",
      })),
      tests: [{ command: "<exact command>", exitCode: 0, summary: "<short result>" }],
      claimedFiles: ["path/to/changed/file"],
    }),
  ].join("\n");
}

export function buildJudgeContractAppendix(input: {
  workerDelegationRequestId: string;
  integrationAttemptId?: string | null;
  reviewedCandidateCommitSha?: string | null;
  acceptance: TaskAcceptanceCriterion[];
  resultSummary: AgentRuntimeDelegationSummary;
}): string {
  return [
    "## Independent Judge contract (no apply or commit authority)",
    "",
    `Worker attempt: ${input.workerDelegationRequestId}`,
    ...(input.integrationAttemptId ? [`Integration attempt: ${input.integrationAttemptId}`] : []),
    ...(input.reviewedCandidateCommitSha ? [`Exact reviewed candidate: ${input.reviewedCandidateCommitSha}`] : []),
    `Worker safe summary: ${input.resultSummary.safeSummary}`,
    `Backend-attested files: ${(input.resultSummary.attestedFiles ?? []).join(", ") || "none"}`,
    "",
    "Decide every frozen criterion from the candidate diff and evidence:",
    ...input.acceptance.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
    "",
    "Emit exactly one structured decision. Do not modify, apply, stage, or commit files:",
    "",
    controlExample({
      type: "managed_review.decision",
      workerDelegationRequestId: input.workerDelegationRequestId,
      ...(input.integrationAttemptId ? { integrationAttemptId: input.integrationAttemptId } : {}),
      ...(input.reviewedCandidateCommitSha ? { reviewedCandidateCommitSha: input.reviewedCandidateCommitSha } : {}),
      verdict: "accepted",
      decisions: input.acceptance.map((criterion) => ({
        criterionId: criterion.id,
        outcome: "PASS",
        safeSummary: "What directly supports this decision.",
      })),
      safeSummary: "Short overall judge summary.",
      deferredFindings: [],
    }),
  ].join("\n");
}

export function buildIntegratorContractAppendix(input: {
  integrationAttemptId: string;
  workerDelegationRequestId: string;
  checkpointHead: string;
  originalCandidateCommitSha: string;
  acceptance: TaskAcceptanceCriterion[];
  conflictFiles: string[];
  allowedFiles: string[];
}): string {
  return [
    "## Integrator contract (isolated conflict recovery; no acceptance or commit authority)",
    "",
    `Integration attempt: ${input.integrationAttemptId}`,
    `Worker attempt: ${input.workerDelegationRequestId}`,
    `Checkpoint HEAD: ${input.checkpointHead}`,
    `Original candidate: ${input.originalCandidateCommitSha}`,
    `Conflict files: ${input.conflictFiles.join(", ") || "none"}`,
    `Allowed files: ${input.allowedFiles.join(", ") || "none"}`,
    "",
    "Resolve the existing index conflicts while preserving the frozen acceptance contract:",
    ...input.acceptance.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
    "",
    "Do not commit, move HEAD, add files outside the allowed list, or modify the supervisor workspace.",
    "Stage resolved conflict files if needed, then emit exactly one structured result:",
    "",
    controlExample({
      type: "managed_integration.result",
      integrationAttemptId: input.integrationAttemptId,
      workerDelegationRequestId: input.workerDelegationRequestId,
      originalCandidateCommitSha: input.originalCandidateCommitSha,
      safeSummary: "Short summary of how the conflicts were resolved.",
    }),
  ].join("\n");
}

export interface SpecWriterChangeContext {
  id: string;
  title: string;
  rationale: string;
  dependsOn: string[];
  /** Verbatim Supervisor rejection summary driving a corrective attempt. */
  supervisorFeedback?: string | null;
}

/**
 * Appendix appended to a spec-writer child's prompt at dispatch: the change
 * context, target artifact paths, and minimal filled templates. Provider-
 * neutral markdown authoring instructions only — the OpenSpec CLI workflow
 * stays backend-owned and is never taught to agents.
 */
export function buildSpecWriterAppendix(change: SpecWriterChangeContext): string {
  return [
    `## Spec authoring assignment (change: ${change.id})`,
    "",
    `Title: ${change.title}`,
    `Rationale: ${change.rationale}`,
    ...(change.dependsOn.length > 0 ? [`Depends on: ${change.dependsOn.join(", ")}`] : []),
    "",
    "Author these markdown files in your workspace (scaffolding already exists):",
    "",
    `- openspec/changes/${change.id}/proposal.md — Why this change and what it changes`,
    `- openspec/changes/${change.id}/specs/<capability>/spec.md — one file per capability this change touches`,
    `- openspec/changes/${change.id}/tasks.md — ordered implementation tasks`,
    "",
    "Structural rules (the backend validates these):",
    "- Every spec file is a delta: group requirements under a",
    "  `## ADDED Requirements` heading (or `## MODIFIED Requirements` when",
    "  changing an existing one). A spec file without a delta heading fails",
    "  validation.",
    "- Every requirement heading uses `### Requirement:` and is followed by at",
    "  least one `#### Scenario:` block with **WHEN**/**THEN** bullet lines.",
    "- Every task is a `- [ ]` checkbox followed by an indented `Acceptance:`",
    "  line listing binary, testable conditions.",
    "",
    "Example spec file shape:",
    "",
    "```markdown",
    "## ADDED Requirements",
    "",
    "### Requirement: Users can reset their password",
    "The system SHALL send a reset link when a registered user requests one.",
    "",
    "#### Scenario: Reset link is issued",
    "- **WHEN** a registered user requests a password reset",
    "- **THEN** the system emails a single-use reset link",
    "```",
    "",
    "Example tasks file shape:",
    "",
    "```markdown",
    "- [ ] 1.1 Add the reset request endpoint",
    "  - Acceptance: POST /reset returns 202 for registered emails.",
    "```",
    "",
    "Do not install or run any OpenSpec tooling; author the markdown files",
    "only. The backend performs all validation and archiving.",
    ...(change.supervisorFeedback
      ? ["", "## Supervisor revision request", "", change.supervisorFeedback]
      : []),
  ].join("\n");
}

function goalSection(goal: SupervisorPromptGoal): string {
  return ["## Goal", "", `Title: ${goal.title}`, `Description: ${goal.description}`].join("\n");
}

function phaseHeader(phase: SupervisorPromptPhase): string {
  if (phase.kind === "continuation") {
    return [
      "A child agent you delegated to has finished.",
      "",
      `Worker result: ${phase.observation}`,
      "",
      "Decide the next step: re-delegate this task, delegate the next task,",
      "request a review merge, or complete the goal.",
    ].join("\n");
  }
  if (phase.kind === "nudge") {
    return [
      "Your previous session ended without a completion signal and without a",
      "pending delegation. Continue or complete the goal now: delegate the next",
      "task, or emit a `managed_delegation.complete` control block if the goal is",
      "already delivered.",
    ].join("\n");
  }
  if (phase.kind === "rejection") {
    return [
      "Your last control block was rejected and has not been executed.",
      "",
      `Rejection reason: ${phase.safeReason}`,
      "",
      "Emit a corrected control block using the formats below.",
    ].join("\n");
  }
  return "You have been given a goal to deliver end to end.";
}
