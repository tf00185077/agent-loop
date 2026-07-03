import React, { useEffect, useState } from "react";
import { listEvents, openEventStream, GoalEvent } from "./api";
import { appendEvent, isAgentSessionRefreshEvent, isTerminalEvent } from "./event-timeline-state";
import { eventRunMetadata } from "./run-metadata";

interface Props {
  goalId: string;
  refreshKey: number;
  onAgentSessionEvent?: (event: GoalEvent) => void;
}

export default function EventTimeline({ goalId, refreshKey, onAgentSessionEvent }: Props) {
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
          if (isAgentSessionRefreshEvent(event)) onAgentSessionEvent?.(event);
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
  }, [goalId, refreshKey, onAgentSessionEvent]);

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
          const details = observationDetails(e);

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
                  {eventLabel(e)}
                  {metadata && <RunMetadataBadge provider={metadata.provider} model={metadata.model} />}
                </span>
                <span style={{ color: "#888" }}>{fmt(e.createdAt)}</span>
              </div>
              <div style={{ marginTop: 2 }}>{e.message}</div>
              {details.length > 0 && (
                <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>
                  {details.join(" · ")}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function eventLabel(event: GoalEvent): string {
  const observationKind =
    typeof event.data.observationKind === "string" ? event.data.observationKind : null;
  switch (observationKind ?? event.type.replace(/^agent\./, "")) {
    case "heartbeat":
      return "Heartbeat";
    case "progress":
      return "Progress";
    case "command.started":
      return "Command started";
    case "command.completed":
      return "Command completed";
    case "command.failed":
      return "Command failed";
    case "subtask.started":
      return "Subtask started";
    case "subtask.completed":
      return "Subtask completed";
    case "subtask.failed":
      return "Subtask failed";
    default:
      return event.type;
  }
}

function observationDetails(event: GoalEvent): string[] {
  if (!event.type.startsWith("agent.")) return [];

  const details = [
    textValue(event.data.agentRole),
    textValue(event.data.agentId),
    textValue(event.data.parentAgentId),
    textValue(event.data.taskId),
    textValue(event.data.source),
    textValue(event.data.rawEventType),
  ];

  const command = recordValue(event.data.command);
  if (command) {
    details.push(textValue(command.label), textValue(command.status));
  }

  const subtask = recordValue(event.data.subtask);
  if (subtask) {
    details.push(textValue(subtask.title), textValue(subtask.status));
  }

  details.push(
    textValue(event.data.reviewMergeOutcome),
    textValue(event.data.diffSummary),
    textValue(event.data.safeSummary),
  );
  const fixedTest = recordValue(event.data.fixedTest);
  if (fixedTest) {
    details.push(textValue(fixedTest.command), textValue(fixedTest.outputSummary));
  }
  const revertEvidence = recordValue(event.data.revertEvidence);
  if (revertEvidence) {
    details.push(textValue(revertEvidence.summary));
  }

  return details.filter((detail): detail is string => Boolean(detail));
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
