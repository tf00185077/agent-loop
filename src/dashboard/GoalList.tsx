import React, { useEffect, useState } from "react";
import { listGoals, Goal } from "./api";

interface Props {
  onSelect: (id: string) => void;
  refreshKey: number;
}

export default function GoalList({ onSelect, refreshKey }: Props) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listGoals()
      .then(setGoals)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  if (loading) return <p>Loading goals…</p>;
  if (error) return <p style={{ color: "red" }}>{error}</p>;
  if (goals.length === 0) return <p style={{ color: "#888" }}>No goals yet. Create one above.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {goals.map((g) => (
        <li
          key={g.id}
          onClick={() => onSelect(g.id)}
          style={{
            padding: "12px 16px",
            marginBottom: 8,
            border: "1px solid #ddd",
            borderRadius: 6,
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontWeight: 500 }}>{g.title}</span>
          <span
            style={{
              fontSize: 12,
              padding: "2px 8px",
              borderRadius: 12,
              background: statusColor(g.status),
              color: "#fff",
            }}
          >
            {g.status}
          </span>
        </li>
      ))}
    </ul>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "draft": return "#888";
    case "running": return "#2196f3";
    case "completed": return "#4caf50";
    case "blocked": return "#f44336";
    case "waiting_user": return "#ff9800";
    case "interrupted": return "#ff9800";
    default: return "#999";
  }
}
