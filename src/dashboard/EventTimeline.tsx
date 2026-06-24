import React, { useEffect, useState } from "react";
import { listEvents, openEventStream, GoalEvent } from "./api";
import { appendEvent, isTerminalEvent } from "./event-timeline-state";
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
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    setLoading(true);
    setError(null);

    listEvents(goalId)
      .then((snapshot) => {
        if (cancelled) return;
        setEvents(snapshot);
        unsubscribe = openEventStream(goalId, (event) => {
          setEvents((prev) => appendEvent(prev, event));
          if (isTerminalEvent(event)) unsubscribe?.();
        });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
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
