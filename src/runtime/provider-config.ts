export type ProviderEnvironment = Record<string, string | undefined>;

export type ProviderConfig = MockProviderConfig | OpenAICompatibleProviderConfig;

export interface MockProviderConfig {
  provider: "mock";
  model: "mock-v1";
}

export interface OpenAICompatibleProviderConfig {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function loadProviderConfig(env: ProviderEnvironment): ProviderConfig {
  const provider = readEnv(env, "AUTO_AGENT_PROVIDER") ?? "mock";

  if (provider === "mock") {
    return { provider: "mock", model: "mock-v1" };
  }

  if (provider === "openai-compatible") {
    return {
      provider,
      baseUrl: readEnv(env, "AUTO_AGENT_BASE_URL") ?? "",
      apiKey: readEnv(env, "AUTO_AGENT_API_KEY") ?? "",
      model: readEnv(env, "AUTO_AGENT_MODEL") ?? "",
    };
  }

  throw new ProviderConfigError(`Unsupported AUTO_AGENT_PROVIDER: ${provider}`);
}

function readEnv(env: ProviderEnvironment, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}
