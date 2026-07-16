import type { Event, ManagedChangeStatus } from "../../domain/index.js";

export interface PlanningEpochChangeProjection {
  id: string;
  title: string;
  status: ManagedChangeStatus;
}

export interface PlanningEpochReassessmentProjection {
  goalSatisfied: boolean;
  evidence: string[];
  remainingGaps: string[];
  nextEpochRationale: string | null;
}

export type PlanningEpochStatus = "executing" | "reassessing" | "gaps_found" | "completed" | "blocked";

export interface PlanningEpochProjection {
  sequence: number;
  rationale: string | null;
  status: PlanningEpochStatus;
  changes: PlanningEpochChangeProjection[];
  reassessment: PlanningEpochReassessmentProjection | null;
}

/**
 * Pure fold of the durable event timeline into the goal's planning epochs:
 * which round the goal is in, each round's changes and statuses, and the
 * reassessment that concluded it. Read-only view for the API/dashboard; the
 * change registry remains the enforcement surface.
 */
export function projectPlanningEpochs(events: Event[]): PlanningEpochProjection[] {
  interface EpochAccumulator {
    sequence: number;
    rationale: string | null;
    changeIds: string[];
    reassessment: PlanningEpochReassessmentProjection | null;
  }
  const epochs: EpochAccumulator[] = [];
  const changes = new Map<string, { title: string; status: ManagedChangeStatus }>();

  for (const event of events) {
    const type = event.data.runtimeEventType;
    if (type === "supervisor.change_plan") {
      const changePlan = event.data.changePlan;
      if (!Array.isArray(changePlan) || changePlan.length === 0) continue;
      const epoch: EpochAccumulator = {
        sequence:
          typeof event.data.epochSequence === "number" ? event.data.epochSequence : epochs.length + 1,
        rationale: typeof event.data.epochRationale === "string" ? event.data.epochRationale : null,
        changeIds: [],
        reassessment: null,
      };
      for (const entry of changePlan) {
        if (typeof entry !== "object" || entry === null) continue;
        const { id, title } = entry as { id?: unknown; title?: unknown };
        if (typeof id !== "string") continue;
        epoch.changeIds.push(id);
        changes.set(id, { title: typeof title === "string" ? title : id, status: "planned" });
      }
      epochs.push(epoch);
      continue;
    }
    if (type === "supervisor.reassessment") {
      const epoch =
        epochs.find((candidate) => candidate.sequence === event.data.epochSequence) ?? epochs.at(-1);
      if (epoch) {
        epoch.reassessment = {
          goalSatisfied: event.data.goalSatisfied === true,
          evidence: stringList(event.data.evidence),
          remainingGaps: stringList(event.data.remainingGaps),
          nextEpochRationale:
            typeof event.data.nextEpochRationale === "string" ? event.data.nextEpochRationale : null,
        };
      }
      continue;
    }
    const changeId = event.data.changeId;
    if (typeof changeId !== "string") continue;
    const change = changes.get(changeId);
    if (!change) continue;
    if (type === "change.activated") change.status = "specifying";
    else if (type === "change.spec_approved") change.status = "executing";
    else if (type === "change.archived") change.status = "archived";
    else if (type === "change.blocked") change.status = "blocked";
  }

  return epochs.map((epoch) => {
    const epochChanges = epoch.changeIds.map((id) => {
      const change = changes.get(id)!;
      return { id, title: change.title, status: change.status };
    });
    return {
      sequence: epoch.sequence,
      rationale: epoch.rationale,
      status: deriveEpochStatus(epochChanges, epoch.reassessment),
      changes: epochChanges,
      reassessment: epoch.reassessment,
    };
  });
}

function deriveEpochStatus(
  changes: PlanningEpochChangeProjection[],
  reassessment: PlanningEpochReassessmentProjection | null,
): PlanningEpochStatus {
  if (changes.some((change) => change.status === "blocked")) return "blocked";
  if (reassessment) return reassessment.goalSatisfied ? "completed" : "gaps_found";
  if (changes.every((change) => change.status === "archived")) return "reassessing";
  return "executing";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
