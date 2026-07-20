import type { GoalInputRequest, GoalInputResponse } from "../../domain/index.js";

const MAX_GUIDANCE_LENGTH = 4000;
const MAX_ABANDON_REASON_LENGTH = 1000;

export type GoalInputResponseValidation =
  | { ok: true; response: GoalInputResponse }
  | { ok: false; safeReason: string };

/**
 * Deterministic validation of a caller's answer to a goal input request —
 * the reverse direction of control-block validation. The caller may be a
 * human dashboard or another agent; both get the same machine-checkable
 * contract and the same safe reasons.
 */
export function validateGoalInputResponse(
  request: GoalInputRequest,
  body: unknown,
  baseBudget: number,
): GoalInputResponseValidation {
  const allowed = request.payload.allowedDecisions;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalid(`Response must be a JSON object with a decision field. Allowed decisions: ${allowed.join(", ")}.`);
  }
  const record = body as Record<string, unknown>;
  const decision = record.decision;
  if (typeof decision !== "string" || !allowed.includes(decision as GoalInputResponse["decision"])) {
    return invalid(
      `Decision ${typeof decision === "string" ? `"${decision}"` : "(missing)"} is not allowed for this request. ` +
        `Allowed decisions: ${allowed.join(", ")}.`,
    );
  }

  if (decision === "extend_budget") {
    const extension = record.extension;
    if (typeof extension !== "number" || !Number.isInteger(extension) || extension < 1 || extension > baseBudget) {
      return invalid(
        `extend_budget requires an integer extension between 1 and ${baseBudget} (the configured base budget).`,
      );
    }
    return { ok: true, response: { decision: "extend_budget", extension } };
  }

  if (decision === "provide_guidance") {
    const guidance = typeof record.guidance === "string" ? record.guidance.trim() : "";
    if (guidance.length === 0) {
      return invalid("provide_guidance requires a non-empty guidance string.");
    }
    if (guidance.length > MAX_GUIDANCE_LENGTH) {
      return invalid(`Guidance is limited to ${MAX_GUIDANCE_LENGTH} characters.`);
    }
    return { ok: true, response: { decision: "provide_guidance", guidance } };
  }

  const reason = record.reason;
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return invalid("abandon accepts an optional string reason.");
  }
  const trimmed = typeof reason === "string" ? reason.trim().slice(0, MAX_ABANDON_REASON_LENGTH) : "";
  return { ok: true, response: { decision: "abandon", reason: trimmed.length > 0 ? trimmed : null } };
}

function invalid(safeReason: string): GoalInputResponseValidation {
  return { ok: false, safeReason };
}
