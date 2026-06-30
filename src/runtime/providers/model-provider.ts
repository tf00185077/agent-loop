import type { AgentObservation } from "../../domain/index.js";

export interface ModelProvider {
  /** Display-only provider/model metadata known before execution, if available. */
  metadata?: ModelProviderMetadata;
  /** Provider-owned runtime features used by higher-level code for continuation decisions. */
  capabilities?: ModelProviderCapabilities;
  complete(input: ModelProviderInput): Promise<ModelProviderOutput>;
}

export interface ModelProviderInput {
  goal: ModelProviderGoalContext;
  prompt: string;
  /**
   * Opaque, provider-owned continuation token. The runtime forwards a value
   * previously returned by the same provider without inspecting it so the
   * provider can resume a session. Undefined starts a fresh interaction.
   */
  conversationState?: unknown;
  /** Provider-neutral continuation intent chosen by the runtime. */
  continuation?: ModelProviderContinuation;
  /**
   * Optional sink for raw, unsanitized process output chunks or structured
   * observations seen while the provider runs. The runtime sanitizes and
   * persists non-empty progress; providers that have no streamable output may
   * simply not call it.
   */
  onProgress?: (progress: string | AgentObservation) => void;
}

export interface ModelProviderGoalContext {
  id: string;
  title: string;
  description: string | null;
}

export interface ModelProviderOutput {
  text: string;
  metadata: ModelProviderMetadata;
  /**
   * Opaque, provider-owned continuation token to hand back on a later call.
   * The runtime stores and forwards it verbatim and never interprets it.
   */
  conversationState?: unknown;
}

export interface ModelProviderMetadata {
  provider: string;
  model: string;
}

export interface ModelProviderCapabilities {
  trueResume: boolean;
  continuationFallback: boolean;
  managedHome: boolean;
  jsonlEvents: boolean;
}

export interface ModelProviderContinuation {
  mode: "resume" | "fresh";
  reason?: string;
}
