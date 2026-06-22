import type { GoalEvent } from "./api.js";

export interface RunDisplayMetadata {
  provider: string;
  model: string;
}

export function eventRunMetadata(event: GoalEvent): RunDisplayMetadata | null {
  const provider = event.data.provider;
  const model = event.data.model;

  if (typeof provider !== "string" || typeof model !== "string") {
    return null;
  }

  return { provider, model };
}

export function latestRunMetadata(events: GoalEvent[]): RunDisplayMetadata | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const metadata = eventRunMetadata(events[i]);
    if (metadata) return metadata;
  }

  return null;
}
