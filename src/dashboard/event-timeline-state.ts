import type { GoalEvent } from "./api.js";

const TERMINAL_EVENT_TYPES = new Set(["goal.completed", "goal.blocked", "error"]);

export function appendEvent(events: GoalEvent[], incoming: GoalEvent): GoalEvent[] {
  if (events.some((e) => e.id === incoming.id)) return events;
  return [...events, incoming];
}

export function isTerminalEvent(event: GoalEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}
