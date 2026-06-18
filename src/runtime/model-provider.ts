export interface ModelProvider {
  complete(input: ModelProviderInput): Promise<ModelProviderOutput>;
}

export interface ModelProviderInput {
  goal: ModelProviderGoalContext;
  prompt: string;
}

export interface ModelProviderGoalContext {
  id: string;
  title: string;
  description: string | null;
}

export interface ModelProviderOutput {
  text: string;
  metadata: ModelProviderMetadata;
}

export interface ModelProviderMetadata {
  provider: string;
  model: string;
}
