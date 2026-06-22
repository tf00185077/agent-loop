import type { ModelProvider, ModelProviderInput, ModelProviderOutput } from "./model-provider.js";
import type { OpenAICompatibleProviderConfig } from "./provider-config.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAICompatibleProviderDeps {
  config: OpenAICompatibleProviderConfig;
  fetch?: FetchLike;
}

export class OpenAICompatibleProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
  }
}

export function createOpenAICompatibleProvider(deps: OpenAICompatibleProviderDeps): ModelProvider {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const config = deps.config;
  const metadata = {
    provider: config.provider,
    model: config.model,
  };

  return {
    metadata,
    async complete(input) {
      validateConfig(config);

      const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toChatCompletionsPayload(config.model, input)),
      });

      if (!response.ok) {
        throw new OpenAICompatibleProviderError(
          `OpenAI-compatible provider returned HTTP ${response.status}`,
        );
      }

      const body = (await response.json()) as unknown;
      const text = extractAssistantText(body);

      return {
        text,
        metadata,
      } satisfies ModelProviderOutput;
    },
  };
}

function validateConfig(config: OpenAICompatibleProviderConfig): void {
  if (!config.baseUrl) throw new OpenAICompatibleProviderError("AUTO_AGENT_BASE_URL is required");
  if (!config.apiKey) throw new OpenAICompatibleProviderError("AUTO_AGENT_API_KEY is required");
  if (!config.model) throw new OpenAICompatibleProviderError("AUTO_AGENT_MODEL is required");
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function toChatCompletionsPayload(model: string, input: ModelProviderInput) {
  return {
    model,
    messages: [
      {
        role: "system",
        content: "You are a concise assistant running a one-step auto-agent smoke test.",
      },
      {
        role: "user",
        content: input.prompt,
      },
    ],
  };
}

function extractAssistantText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    throw new OpenAICompatibleProviderError("OpenAI-compatible response is missing choices");
  }

  const firstChoice = body.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new OpenAICompatibleProviderError("OpenAI-compatible response is missing assistant message");
  }

  const content = firstChoice.message.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new OpenAICompatibleProviderError("OpenAI-compatible response is missing assistant text");
  }

  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
