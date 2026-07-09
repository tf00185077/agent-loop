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
  "2. Delegate exactly one worker task at a time with a `managed_delegation.request`",
  "   control block (role `worker`). Wait for its result before the next delegation.",
  "3. After worker results that changed files, request a review-merge child",
  "   (role `review_merge`, referencing the worker delegation request id you were",
  "   given) before treating the task as delivered.",
  "4. When every task is delivered, emit a `managed_delegation.complete` control",
  "   block with a short result summary. The goal only completes when you emit it.",
  "5. Only fenced `auto-agent-control` blocks are honored as control signals;",
  "   anything else is treated as progress commentary.",
  "",
  "Control block formats (one JSON object per fenced block):",
  "",
  controlExample({
    type: "managed_delegation.task_list",
    tasks: [
      { id: "task-1", title: "First concrete task" },
      { id: "task-2", title: "Second concrete task" },
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
  return [phaseHeader(input.phase), goalSection(input.goal), CONTRACT].join("\n\n");
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
