export type ProviderEnvironment = Record<string, string | undefined>;

export type ProviderConfig =
  | MockProviderConfig
  | OpenAILocalAgentProviderConfig
  | OpenAICompatibleProviderConfig;

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

export interface OpenAILocalAgentProviderConfig {
  provider: "openai-local-agent";
  command: string;
  args: string[];
  model: string;
  timeoutMs: number;
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

  if (provider === "openai-local-agent") {
    return {
      provider,
      command: readEnv(env, "AUTO_AGENT_OPENAI_LOCAL_COMMAND") ?? "",
      args: readStringArrayEnv(env, "AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON") ?? [],
      model: readEnv(env, "AUTO_AGENT_OPENAI_LOCAL_MODEL") ?? "openai-subscription-local-agent",
      timeoutMs: readPositiveIntegerEnv(env, "AUTO_AGENT_OPENAI_LOCAL_TIMEOUT_MS") ?? 120_000,
    };
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

function readStringArrayEnv(env: ProviderEnvironment, key: string): string[] | undefined {
  const value = readEnv(env, key);
  if (!value) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProviderConfigError(`${key} must be a JSON array of strings`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new ProviderConfigError(`${key} must be a JSON array of strings`);
  }

  return parsed;
}

function readPositiveIntegerEnv(env: ProviderEnvironment, key: string): number | undefined {
  const value = readEnv(env, key);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProviderConfigError(`${key} must be a positive integer`);
  }

  return parsed;
}
