import { spawn } from "node:child_process";

import type { ModelProvider, ModelProviderInput, ModelProviderOutput } from "./model-provider.js";
import type { OpenAILocalAgentProviderConfig } from "./provider-config.js";

export interface OpenAILocalAgentProviderDeps {
  config: OpenAILocalAgentProviderConfig;
}

export class OpenAILocalAgentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAILocalAgentProviderError";
  }
}

export function createOpenAILocalAgentProvider(deps: OpenAILocalAgentProviderDeps): ModelProvider {
  const config = deps.config;

  return {
    async complete(input) {
      validateConfig(config);
      const stdout = await runLocalAgentCommand(config, input);
      const text = extractResponseText(stdout);

      return {
        text,
        metadata: {
          provider: config.provider,
          model: config.model,
        },
      } satisfies ModelProviderOutput;
    },
  };
}

function validateConfig(config: OpenAILocalAgentProviderConfig): void {
  if (!config.command) {
    throw new OpenAILocalAgentProviderError("AUTO_AGENT_OPENAI_LOCAL_COMMAND is required");
  }
}

function runLocalAgentCommand(
  config: OpenAILocalAgentProviderConfig,
  input: ModelProviderInput,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args, {
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new OpenAILocalAgentProviderError("OpenAI local agent command timed out"));
    }, config.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new OpenAILocalAgentProviderError(`OpenAI local agent failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(
          new OpenAILocalAgentProviderError(
            `OpenAI local agent exited with code ${code}: ${stderr.trim() || "no stderr"}`,
          ),
        );
        return;
      }

      resolve(stdout);
    });

    child.stdin.end(`${JSON.stringify(toLocalAgentInput(input))}\n`);
  });
}

function toLocalAgentInput(input: ModelProviderInput) {
  return {
    goal: input.goal,
    prompt: input.prompt,
  };
}

function extractResponseText(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OpenAILocalAgentProviderError("OpenAI local agent output must be JSON");
  }

  if (!isRecord(parsed) || typeof parsed.text !== "string" || !parsed.text.trim()) {
    throw new OpenAILocalAgentProviderError("OpenAI local agent output must include non-empty text");
  }

  return parsed.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
