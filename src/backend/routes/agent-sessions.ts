import { Router } from "express";

import type { AgentSessionRepository } from "../../persistence/runtime-repositories.js";
import type { AgentSessionManager } from "../../runtime/agent-session/agent-session-manager.js";
import { sanitizeAgentRuntimeApprovalRequest } from "../../runtime/safety/agent-runtime-control-plane-sanitizer.js";

interface AgentSessionRouterDeps {
  agentSessionRepo: AgentSessionRepository;
  agentSessionManager?: AgentSessionManager;
}

export function createAgentSessionRouter(deps: AgentSessionRouterDeps): Router {
  const router = Router();

  router.post("/:sessionId/approvals/:approvalId/approve", async (req, res, next) => {
    try {
      const approval = findApproval(deps.agentSessionRepo, req.params.sessionId, req.params.approvalId);
      if (!approval) {
        res.status(404).json({ error: "Approval request not found" });
        return;
      }

      if (approval.status === "pending") {
        await deps.agentSessionManager?.approve(req.params.sessionId, req.params.approvalId);
      }

      res.json(
        sanitizeAgentRuntimeApprovalRequest(
          deps.agentSessionRepo.resolveApprovalRequest(req.params.approvalId, "approved"),
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/:sessionId/approvals/:approvalId/reject", async (req, res, next) => {
    try {
      const approval = findApproval(deps.agentSessionRepo, req.params.sessionId, req.params.approvalId);
      if (!approval) {
        res.status(404).json({ error: "Approval request not found" });
        return;
      }

      const reason = parseOptionalReason(req.body);
      if (!reason.ok) {
        res.status(400).json({ error: reason.error });
        return;
      }

      if (approval.status === "pending") {
        await deps.agentSessionManager?.reject(req.params.sessionId, req.params.approvalId, reason.reason ?? undefined);
      }

      res.json(
        sanitizeAgentRuntimeApprovalRequest(
          deps.agentSessionRepo.resolveApprovalRequest(req.params.approvalId, "rejected", reason.reason),
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/:sessionId/cancel", async (req, res, next) => {
    try {
      const session = deps.agentSessionRepo.getSession(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: "Agent session not found" });
        return;
      }

      await deps.agentSessionManager?.cancel(session.id, "Session cancelled.");

      for (const approval of deps.agentSessionRepo.listApprovalRequests(session.id)) {
        if (approval.status === "pending") {
          deps.agentSessionRepo.resolveApprovalRequest(approval.id, "cancelled", "Session cancelled.");
        }
      }

      res.json(deps.agentSessionRepo.updateLifecycleState(session.id, "cancelled"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function findApproval(
  agentSessionRepo: AgentSessionRepository,
  sessionId: string,
  approvalId: string,
) {
  return agentSessionRepo
    .listApprovalRequests(sessionId)
    .map(sanitizeAgentRuntimeApprovalRequest)
    .find((approval) => approval.id === approvalId);
}

type ParseOptionalReasonResult =
  | { ok: true; reason: string | null }
  | { ok: false; error: string };

function parseOptionalReason(body: unknown): ParseOptionalReasonResult {
  if (body === undefined || body === null || (isRecord(body) && body.reason === undefined)) {
    return { ok: true, reason: null };
  }
  if (!isRecord(body) || (body.reason !== null && typeof body.reason !== "string")) {
    return { ok: false, error: "reason must be a string or null" };
  }

  return { ok: true, reason: body.reason?.trim() || null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
