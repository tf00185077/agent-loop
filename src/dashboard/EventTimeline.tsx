import React, { useEffect, useState } from "react";
import { listEvents, GoalEvent } from "./api";
import { eventRunMetadata } from "./run-metadata";

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
    <EventTimelineList events={events} />
  );
}

export function EventTimelineList({ events }: { events: GoalEvent[] }) {
  return (
    <div>
      <h3>Event Timeline</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {events.map((e) => {
          const metadata = eventRunMetadata(e);

          return (
            <li
              key={e.id}
              style={{
                padding: "8px 12px",
                borderLeft: "3px solid #ccc",
                marginBottom: 6,
                fontSize: 13,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontWeight: 500 }}>
                  {e.type}
                  {metadata && <RunMetadataBadge provider={metadata.provider} model={metadata.model} />}
                </span>
                <span style={{ color: "#888" }}>{fmt(e.createdAt)}</span>
              </div>
              <div style={{ marginTop: 2 }}>{e.message}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RunMetadataBadge({ provider, model }: { provider: string; model: string }) {
  return (
    <span
      style={{
        color: "#555",
        fontWeight: 400,
        marginLeft: 8,
        whiteSpace: "nowrap",
      }}
    >
      {provider} / {model}
    </span>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString();
}
