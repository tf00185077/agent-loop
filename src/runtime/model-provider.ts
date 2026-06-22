export interface ModelProvider {
  /** Display-only provider/model metadata known before execution, if available. */
  metadata?: ModelProviderMetadata;
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
