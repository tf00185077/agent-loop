import React, { useEffect, useState } from "react";
import {
  approveAgentSessionApproval,
  getAgentSessionSnapshot,
  getGoal,
  listEvents,
  rejectAgentSessionApproval,
  startGoal,
  Goal,
  type AgentSessionSnapshot,
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
}: {
  goal: Goal;
  latestMetadata: RunDisplayMetadata | null;
  agentSessionSnapshot?: AgentSessionSnapshot | null;
  starting: boolean;
  onStart: () => void;
  onApproveApproval?: (approvalId: string) => void;
  onRejectApproval?: (approvalId: string) => void;
}) {
  const session = agentSessionSnapshot?.session ?? null;
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
            <button style={{ padding: "6px 14px", marginBottom: 12 }} type="button">
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
        </section>
      )}
    </div>
  );
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
