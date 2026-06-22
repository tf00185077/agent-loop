import { EventEmitter } from "node:events";

import type { Event } from "../domain/index.js";

export interface EventBus {
  /** Publishes an already-persisted event to subscribers of its goal. */
  publish(event: Event): void;
  /** Subscribes to events for one goal. Returns an unsubscribe function. */
  subscribe(goalId: string, listener: (event: Event) => void): () => void;
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  // One goal stream per connected dashboard client; default cap is too low.
  emitter.setMaxListeners(0);

  return {
    publish(event) {
      emitter.emit(event.goalId, event);
    },
    subscribe(goalId, listener) {
      emitter.on(goalId, listener);
      return () => emitter.off(goalId, listener);
    },
  };
}
