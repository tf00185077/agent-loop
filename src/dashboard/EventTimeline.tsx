import React, { useEffect, useState } from "react";
import { listEvents, GoalEvent } from "./api";

interface Props {
  goalId: string;
  refreshKey: number;
}

export default function EventTimeline({ goalId, refreshKey }: Props) {
  const [events, setEvents] = useState<GoalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listEvents(goalId)
      .then(setEvents)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [goalId, refreshKey]);

  if (loading) return <p>Loading events…</p>;
  if (error) return <p style={{ color: "red" }}>{error}</p>;
  if (events.length === 0) return <p style={{ color: "#888" }}>No events yet.</p>;

  return (
    <div>
      <h3>Event Timeline</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {events.map((e) => (
          <li
            key={e.id}
            style={{
              padding: "8px 12px",
              borderLeft: "3px solid #ccc",
              marginBottom: 6,
              fontSize: 13,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 500 }}>{e.type}</span>
              <span style={{ color: "#888" }}>{fmt(e.createdAt)}</span>
            </div>
            {Object.keys(e.payload ?? {}).length > 0 && (
              <pre
                style={{
                  margin: "4px 0 0",
                  fontSize: 12,
                  color: "#666",
                  whiteSpace: "pre-wrap",
                }}
              >
                {JSON.stringify(e.payload)}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString();
}
