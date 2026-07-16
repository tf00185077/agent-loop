export type GoalStatus =
  | "draft"
  | "running"
  | "waiting_user"
  | "blocked"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";
