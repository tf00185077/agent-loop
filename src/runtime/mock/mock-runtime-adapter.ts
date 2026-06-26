import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentRuntimeEventMetadata,
  AgentSessionHandle,
  AgentSessionInput,
  AgentSessionStartInput,
} from "../../domain/index.js";

export interface MockRuntimeAdapterOptions {
  outcome?: "completed" | "failed";
  pauseBeforeTerminal?: boolean;
  pauseAfterApproval?: boolean;
  onControl?: (control: MockRuntimeAdapterControl) => void;
}

export type MockRuntimeAdapterControl =
  | { type: "send"; sessionId: string; input: AgentSessionInput }
  | { type: "approve"; sessionId: string; requestId: string }
  | { type: "reject"; sessionId: string; requestId: string; reason?: string }
  | { type: "cancel"; sessionId: string; reason?: string };

const MOCK_CAPABILITIES: AgentRuntimeCapabilities = {
  eventStreaming: true,
  approval: true,
  cancellation: true,
  resume: false,
  childSessions: true,
};

export function createMockRuntimeAdapter(options: MockRuntimeAdapterOptions = {}): AgentRuntimeAdapter {
  return {
    providerId: "mock",
    async detectCapabilities() {
      return { ...MOCK_CAPABILITIES };
    },
    async startSession(input) {
      return createMockSessionHandle(input, options);
    },
  };
}

function createMockSessionHandle(input: AgentSessionStartInput, options: MockRuntimeAdapterOptions): AgentSessionHandle {
  let cancelRequested = false;
  let cancelReason: string | undefined;
  let resolveCancellation: (() => void) | undefined;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });

  return {
    sessionId: input.sessionId,
    capabilities: { ...MOCK_CAPABILITIES },
    async *events() {
      yield createEvent(input, "session.started", "Mock session started.");
      yield createEvent(input, "progress", `Mock adapter received prompt: ${input.prompt}`);

      if (options.pauseBeforeTerminal) {
        await cancellation;
        yield createEvent(input, "session.cancelled", `Mock session cancelled: ${cancelReason ?? "Cancelled."}`);
        return;
      }

      if (options.outcome === "failed") {
        yield createEvent(input, "command.started", "Mock command started.", { commandId: "mock-command-1" });
        yield createEvent(input, "command.failed", "Mock command failed.", { commandId: "mock-command-1" });
        yield createEvent(input, "session.failed", "Mock session failed deterministically.");
        return;
      }

      yield createEvent(input, "command.started", "Mock command started.", { commandId: "mock-command-1" });
      yield createEvent(input, "approval.requested", "Mock approval requested.", {
        approvalRequestId: "mock-approval-1",
        commandId: "mock-command-1",
      });

      if (options.pauseAfterApproval) {
        await cancellation;
        yield createEvent(input, "session.cancelled", `Mock session cancelled: ${cancelReason ?? "Cancelled."}`);
        return;
      }

      yield createEvent(input, "child_session.requested", "Mock child session requested.", {
        childSessionRequestId: "mock-child-session-1",
        parentAgentId: "mock-parent-agent",
        taskId: "mock-task-1",
      });
      yield createEvent(input, "command.completed", "Mock command completed.", { commandId: "mock-command-1" });

      if (cancelRequested) {
        yield createEvent(input, "session.cancelled", `Mock session cancelled: ${cancelReason ?? "Cancelled."}`);
        return;
      }

      yield createEvent(input, "session.completed", "Mock session completed.");
    },
    async send(message) {
      options.onControl?.({ type: "send", sessionId: input.sessionId, input: message });
    },
    async approve(requestId) {
      options.onControl?.({ type: "approve", sessionId: input.sessionId, requestId });
    },
    async reject(requestId, reason) {
      options.onControl?.({ type: "reject", sessionId: input.sessionId, requestId, reason });
    },
    async cancel(reason) {
      if (cancelRequested) return;
      cancelRequested = true;
      cancelReason = reason;
      options.onControl?.({ type: "cancel", sessionId: input.sessionId, reason });
      resolveCancellation?.();
    },
  };
}

function createEvent(
  input: AgentSessionStartInput,
  type: AgentRuntimeEvent["type"],
  message: string,
  metadata: AgentRuntimeEventMetadata = {},
): AgentRuntimeEvent {
  return {
    type,
    sessionId: input.sessionId,
    goalId: input.goalId,
    runId: input.runId,
    message,
    occurredAt: new Date().toISOString(),
    metadata: {
      providerId: input.providerId,
      modelLabel: input.modelLabel,
      ...metadata,
    },
  };
}
