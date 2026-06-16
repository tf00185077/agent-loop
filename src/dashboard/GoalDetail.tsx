import React, { useEffect, useState } from "react";
import { getGoal, startGoal, Goal } from "./api";

interface Props {
  goalId: string;
  refreshKey: number;
  onStarted?: () => void;
}

export default function GoalDetail({ goalId, refreshKey, onStarted }: Props) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setLoading(true);
    getGoal(goalId)
      .then(setGoal)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [goalId, refreshKey, version]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      await startGoal(goalId);
      setVersion((v) => v + 1);
      onStarted?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (error) return <p style={{ color: "red" }}>{error}</p>;
  if (!goal) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{goal.title}</h2>
        <StatusBadge status={goal.status} />
        {goal.status === "draft" && (
          <button onClick={handleStart} disabled={starting} style={{ marginLeft: "auto", padding: "6px 14px", cursor: "pointer" }}>
            {starting ? "Starting…" : "Start"}
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
          {goal.blockedAt && <Row label="Blocked" value={fmt(goal.blockedAt)} />}
        </tbody>
      </table>
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
