import type { TaskAcceptanceCriterion } from "../../domain/index.js";
import type { TaskRecord } from "./task-registry.js";

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
  "1. First, decompose the goal into an ordered task list and announce it with a",
  "   `managed_delegation.task_list` control block before delegating anything.",
  "   Every task MUST include acceptance criteria: an immutable id (A1, A2, ...)",
  "   and one binary, testable condition each. Delegating a task without",
  "   acceptance criteria is rejected by the backend.",
  "2. Acceptance criterion ids are frozen once announced. To reject a worker",
  "   result, cite the failing criterion ids explicitly (for example: A2 fails",
  "   because ...). Objections that cite no criterion id are recorded as",
  "   deferred findings and do not block the task. After two cited rejections",
  "   the backend refuses identical retries: split the failing criteria into",
  "   strictly narrower tasks (fewer criteria, with parentTaskId set).",
  "3. Delegate exactly one worker task at a time with a `managed_delegation.request`",
  "   control block (role `worker`). Wait for its result before the next delegation.",
  "4. After worker results that changed files, request a review-merge child",
  "   (role `review_merge`, referencing the worker delegation request id you were",
  "   given) before treating the task as delivered.",
  "5. When every task is delivered, emit a `managed_delegation.complete` control",
  "   block with a short result summary. The goal only completes when you emit it.",
  "6. Only fenced `auto-agent-control` blocks are honored as control signals;",
  "   anything else is treated as progress commentary.",
  "",
  "Control block formats (one JSON object per fenced block):",
  "",
  controlExample({
    type: "managed_delegation.task_list",
    tasks: [
      {
        id: "task-1",
        title: "First concrete task",
        acceptance: [
          { id: "A1", text: "Binary, testable condition for this task." },
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
    type: "managed_delegation.request",
    role: "review_merge",
    workerDelegationRequestId: "<delegation request id from the worker result>",
    summary: "Review and merge the worker changes",
    prompt: "Apply the worker changes, run the fixed test command, report the outcome.",
  }),
  "",
  controlExample({
    type: "managed_delegation.complete",
    summary: "Short safe summary of what was delivered.",
  }),
].join("\n");

export function buildSupervisorPrompt(input: BuildSupervisorPromptInput): string {
  const sections = [phaseHeader(input.phase), goalSection(input.goal)];
  if (input.phase.kind !== "bootstrap" && input.taskHistory && input.taskHistory.length > 0) {
    sections.push(renderTaskHistory(input.taskHistory));
  }
  sections.push(CONTRACT);
  return sections.join("\n\n");
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
