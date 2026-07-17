import React, { useEffect, useState } from "react";
import {
  approveAgentSessionApproval,
  cancelAgentSession,
  getAgentSessionSnapshot,
  getGoal,
  listEvents,
  rejectAgentSessionApproval,
  startGoal,
  Goal,
  type AgentSessionSnapshot,
  type PlanningEpochReadModel,
  type StartGoalProviderOverride,
} from "./api";
import {
  latestRunMetadata,
  type RunDisplayMetadata,
} from "./run-metadata";

interface Props {
  goalId: string;
  refreshKey: number;
  providerOverride?: StartGoalProviderOverride;
  onStarted?: () => void;
}

export default function GoalDetail({ goalId, refreshKey, providerOverride, onStarted }: Props) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [latestMetadata, setLatestMetadata] = useState<RunDisplayMetadata | null>(null);
  const [agentSessionSnapshot, setAgentSessionSnapshot] = useState<AgentSessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([getGoal(goalId), listEvents(goalId), getAgentSessionSnapshot(goalId)])
      .then(([nextGoal, events, nextAgentSessionSnapshot]) => {
        setGoal(nextGoal);
        setLatestMetadata(latestRunMetadata(events));
        setAgentSessionSnapshot(nextAgentSessionSnapshot);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [goalId, refreshKey, version]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      await startGoal(goalId, providerOverride ? { providerOverride } : undefined);
      setVersion((v) => v + 1);
      onStarted?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  async function refreshAgentSessionSnapshot() {
    setAgentSessionSnapshot(await getAgentSessionSnapshot(goalId));
  }

  async function handleApproveApproval(approvalId: string) {
    const sessionId = agentSessionSnapshot?.session?.id;
    if (!sessionId) return;
    setError(null);
    try {
      await approveAgentSessionApproval(sessionId, approvalId);
      await refreshAgentSessionSnapshot();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRejectApproval(approvalId: string) {
    const sessionId = agentSessionSnapshot?.session?.id;
    if (!sessionId) return;
    setError(null);
    try {
      await rejectAgentSessionApproval(sessionId, approvalId);
      await refreshAgentSessionSnapshot();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleCancelSession() {
    const sessionId = agentSessionSnapshot?.session?.id;
    if (!sessionId) return;
    setError(null);
    try {
      await cancelAgentSession(sessionId);
      await refreshAgentSessionSnapshot();
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading) return <p>Loading...</p>;
  if (error) return <p style={{ color: "red" }}>{error}</p>;
  if (!goal) return null;

  return (
    <GoalDetailPanel
      goal={goal}
      latestMetadata={latestMetadata}
      agentSessionSnapshot={agentSessionSnapshot}
      starting={starting}
      onStart={handleStart}
      onApproveApproval={handleApproveApproval}
      onRejectApproval={handleRejectApproval}
      onCancelSession={handleCancelSession}
    />
  );
}

export function GoalDetailPanel({
  goal,
  latestMetadata,
  agentSessionSnapshot,
  starting,
  onStart,
  onApproveApproval,
  onRejectApproval,
  onCancelSession,
}: {
  goal: Goal;
  latestMetadata: RunDisplayMetadata | null;
  agentSessionSnapshot?: AgentSessionSnapshot | null;
  starting: boolean;
  onStart: () => void;
  onApproveApproval?: (approvalId: string) => void;
  onRejectApproval?: (approvalId: string) => void;
  onCancelSession?: () => void;
}) {
  const session = agentSessionSnapshot?.session ?? null;
  const sessionsById = new Map((agentSessionSnapshot?.sessions ?? []).map((managedSession) => [managedSession.id, managedSession]));
  const mergeOutcomesByDelegation = new Map(
    (agentSessionSnapshot?.mergeOutcomes ?? []).map((outcome) => [outcome.delegationRequestId, outcome]),
  );
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{goal.title}</h2>
        <StatusBadge status={goal.status} />
        {goal.status === "draft" && (
          <button
            onClick={onStart}
            disabled={starting}
            style={{ marginLeft: "auto", padding: "6px 14px", cursor: "pointer" }}
          >
            {starting ? "Starting..." : "Start"}
          </button>
        )}
      </div>

      {goal.description && (
        <p style={{ color: "#555", marginTop: 0 }}>{goal.description}</p>
      )}

      <table style={{ borderCollapse: "collapse", fontSize: 14, marginBottom: 20 }}>
        <tbody>
          <Row label="Priority" value={goal.priority} />
          <Row label="Agent type" value={goal.agentType} />
          <Row label="Created" value={fmt(goal.createdAt)} />
          {goal.startedAt && <Row label="Started" value={fmt(goal.startedAt)} />}
          {goal.completedAt && <Row label="Completed" value={fmt(goal.completedAt)} />}
          {latestMetadata && (
            <>
              <Row label="Run provider" value={latestMetadata.provider} />
              <Row label="Run model" value={latestMetadata.model} />
            </>
          )}
        </tbody>
      </table>
      {agentSessionSnapshot?.liveStatus && (
        <AgentLiveStatusPanel status={agentSessionSnapshot.liveStatus} />
      )}
      {session && (
        <section style={{ marginTop: 12, marginBottom: 20 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Managed session</h3>
          <table style={{ borderCollapse: "collapse", fontSize: 14, marginBottom: 12 }}>
            <tbody>
              <Row label="Session state" value={session.lifecycleState} />
              <Row label="Session provider" value={session.providerId} />
              <Row label="Session model" value={session.modelLabel ?? "default"} />
              <Row label="Last activity" value={fmt(session.lastActivityAt)} />
            </tbody>
          </table>

          {session.capabilities.cancellation && (
            <button
              style={{ padding: "6px 14px", marginBottom: 12 }}
              type="button"
              onClick={() => onCancelSession?.()}
            >
              Cancel session
            </button>
          )}

          {Object.values(session.capabilities.unsupportedReasons ?? {}).map((reason) => (
            <p key={reason} style={{ color: "#8a5a00", margin: "0 0 8px" }}>
              {reason}
            </p>
          ))}

          {(agentSessionSnapshot?.approvals.length ?? 0) > 0 && (
            <table style={{ borderCollapse: "collapse", fontSize: 14, marginTop: 8 }}>
              <tbody>
                {agentSessionSnapshot?.approvals.map((approval) => (
                  <tr key={approval.id}>
                    <td style={{ paddingRight: 24, paddingBottom: 4 }}>{approval.safeSummary}</td>
                    <td style={{ paddingBottom: 4 }}>{approval.status}</td>
                    {session.capabilities.approval && approval.status === "pending" && (
                      <td style={{ paddingLeft: 16, paddingBottom: 4 }}>
                        <button
                          type="button"
                          onClick={() => onApproveApproval?.(approval.id)}
                          style={{ marginRight: 8, padding: "4px 10px" }}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => onRejectApproval?.(approval.id)}
                          style={{ padding: "4px 10px" }}
                        >
                          Reject
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(agentSessionSnapshot?.delegationRequests.length ?? 0) > 0 && (
            <table style={{ borderCollapse: "collapse", fontSize: 14, marginTop: 12 }}>
              <tbody>
                {agentSessionSnapshot?.delegationRequests.map((request) => (
                  <tr key={request.id}>
                    <td style={{ paddingRight: 16, paddingBottom: 4 }}>{request.role}</td>
                    <td style={{ paddingRight: 16, paddingBottom: 4 }}>{request.status}</td>
                    <td style={{ paddingRight: 16, paddingBottom: 4 }}>
                      {request.childSessionId ? `child ${request.childSessionId}` : "child pending"}
                      {request.childSessionId && sessionsById.get(request.childSessionId)?.worktree && (
                        <div style={{ color: "#666", fontSize: 12 }}>
                          {worktreeLabel(sessionsById.get(request.childSessionId)?.worktree)}
                        </div>
                      )}
                    </td>
                    <td style={{ paddingBottom: 4 }}>
                      {request.resultSummary?.safeSummary ?? request.promptSummary}
                      {mergeOutcomesByDelegation.has(request.id) && (
                        <MergeOutcomeDetails outcome={mergeOutcomesByDelegation.get(request.id)!} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {(agentSessionSnapshot?.planningEpochs?.length ?? 0) > 0 && (
        <PlanningEpochBoard epochs={agentSessionSnapshot!.planningEpochs!} />
      )}
      {(agentSessionSnapshot?.managedTasks?.length ?? 0) > 0 && (
        <section style={{ marginTop: 12, marginBottom: 20 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Managed task state</h3>
          <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
            <tbody>
              {agentSessionSnapshot!.managedTasks!.map((task) => (
                <tr key={task.id}>
                  <td style={{ paddingRight: 16, paddingBottom: 4 }}>{task.id}</td>
                  <td style={{ paddingRight: 16, paddingBottom: 4 }}>{task.status}</td>
                  <td style={{ paddingBottom: 4 }}>
                    {task.lastIntegrationStatus
                      ? `integration ${task.lastIntegrationStatus} (${task.integrationAttemptId})`
                      : task.lastSafeSummary}
                    {task.resolvedCandidateCommitSha && (
                      <div style={{ color: "#666", fontSize: 12 }}>
                        {`resolved candidate ${task.resolvedCandidateCommitSha}`}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const EPOCH_STATUS_LABELS: Record<PlanningEpochReadModel["status"], string> = {
  executing: "executing",
  reassessing: "awaiting reassessment",
  gaps_found: "gaps found — next epoch",
  completed: "completed",
  blocked: "blocked",
};

function PlanningEpochBoard({ epochs }: { epochs: PlanningEpochReadModel[] }) {
  return (
    <section style={{ marginTop: 12, marginBottom: 20 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Planning epochs</h3>
      {epochs.map((epoch) => (
        <div
          key={epoch.sequence}
          style={{ border: "1px solid #ddd", borderRadius: 6, padding: 10, marginBottom: 8 }}
        >
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {`Epoch ${epoch.sequence} — ${EPOCH_STATUS_LABELS[epoch.status]}`}
          </div>
          {epoch.rationale && (
            <div style={{ color: "#666", fontSize: 12 }}>{`Why this epoch: ${epoch.rationale}`}</div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {epoch.changes.map((change) => (
              <span
                key={change.id}
                style={{ border: "1px solid #ccc", borderRadius: 4, padding: "2px 8px", fontSize: 13 }}
                title={change.title}
              >
                {`${change.id} · ${change.status}`}
              </span>
            ))}
          </div>
          {epoch.reassessment && (
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {epoch.reassessment.goalSatisfied
                ? "Reassessment: goal satisfied"
                : "Reassessment: gaps remain"}
              {epoch.reassessment.remainingGaps.length > 0 && (
                <ul style={{ margin: "4px 0 0 18px" }}>
                  {epoch.reassessment.remainingGaps.map((gap) => (
                    <li key={`${gap.refs.join("|")}:${gap.summary}`}>
                      {gap.summary}
                      {gap.refs.length > 0 ? ` (${gap.refs.join(", ")})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function AgentLiveStatusPanel({ status }: {
  status: NonNullable<AgentSessionSnapshot["liveStatus"]>;
}) {
  const identities = [
    status.sessionId && `session ${status.sessionId}`,
    status.role && `role ${status.role}`,
    status.taskId && `task ${status.taskId}`,
    status.delegationRequestId && `delegation ${status.delegationRequestId}`,
    status.integrationAttemptId && `integration ${status.integrationAttemptId}`,
  ].filter(Boolean).join(" · ");
  return (
    <section style={{ margin: "12px 0 20px", padding: 12, border: "1px solid #ddd", borderRadius: 6 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Agent live status</h3>
      <div style={{ fontWeight: 600 }}>{humanize(status.state)} · {humanize(status.phase)}</div>
      <p style={{ margin: "6px 0" }}>{status.summary}</p>
      <div style={{ color: "#666", fontSize: 12 }}>
        {[status.provider, status.model].filter(Boolean).join(" · ")}
        {status.lastActivityAt ? ` · ${fmt(status.lastActivityAt)}` : ""}
      </div>
      {identities && <div style={{ color: "#666", fontSize: 12, marginTop: 3 }}>{identities}</div>}
    </section>
  );
}

function humanize(value: string): string {
  const normalized = value.replace(/_/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function MergeOutcomeDetails({
  outcome,
}: {
  outcome: NonNullable<AgentSessionSnapshot["mergeOutcomes"]>[number];
}) {
  const fixedTest = outcome.fixedTest ?? {};
  const revertEvidence = outcome.revertEvidence ?? {};
  return (
    <div style={{ color: "#666", fontSize: 12, marginTop: 2 }}>
      <div>{`merge ${outcome.outcome}`}</div>
      {outcome.diffSummary && <div>{outcome.diffSummary}</div>}
      {typeof fixedTest.command === "string" && (
        <div>{`${fixedTest.command}: exit ${String(fixedTest.exitCode ?? "unknown")}`}</div>
      )}
      {typeof revertEvidence.summary === "string" && <div>{revertEvidence.summary}</div>}
    </div>
  );
}

function worktreeLabel(worktree: { label: string; path: string } | null | undefined): string {
  if (!worktree) return "";
  return worktree.label ? `worktree ${worktree.label}` : `worktree ${worktree.path}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ paddingRight: 24, color: "#888", paddingBottom: 4 }}>{label}</td>
      <td style={{ paddingBottom: 4 }}>{value}</td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "#888",
    running: "#2196f3",
    completed: "#4caf50",
    blocked: "#f44336",
  };
  return (
    <span
      style={{
        fontSize: 12,
        padding: "2px 10px",
        borderRadius: 12,
        background: colors[status] ?? "#999",
        color: "#fff",
      }}
    >
      {status}
    </span>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString();
}
