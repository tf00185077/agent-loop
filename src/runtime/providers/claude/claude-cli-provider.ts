import { spawn } from "node:child_process";

import type { ModelProvider, ModelProviderInput, ModelProviderOutput } from "../model-provider.js";
import { killProcessTree } from "../process-tree.js";

export interface ClaudeCliProviderConfig {
  /** Resolved Claude CLI command path (absolute) used to spawn Claude directly. */
  commandPath: string;
  /** Saved model label; drives both the `--model` argument and run metadata. */
  modelLabel: string | null;
  /** Hard timeout for a single Claude invocation. Defaults to 120s. */
  timeoutMs?: number;
}

export interface ClaudeCliProviderDeps {
  config: ClaudeCliProviderConfig;
}

const PROVIDER_NAME = "claude-cli";
const DEFAULT_MODEL_LABEL = "claude-default";
const DEFAULT_TIMEOUT_MS = 120_000;

export class ClaudeCliProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliProviderError";
  }
}

export function createClaudeCliProvider(deps: ClaudeCliProviderDeps): ModelProvider {
  const config = deps.config;
  const metadata = {
    provider: PROVIDER_NAME,
    model: describeClaudeModelLabel(config.modelLabel),
  };

  return {
    metadata,
    async complete(input) {
      if (!config.commandPath?.trim()) {
        throw new ClaudeCliProviderError("Claude command path is required");
      }

      const text = await runClaudePrint(config, input);

      return {
        text,
        metadata,
        conversationState: undefined,
      } satisfies ModelProviderOutput;
    },
  };
}

/** Returns the model slug to pass as `--model`, or null to let Claude default. */
function resolveClaudeModelArgument(modelLabel: string | null): string | null {
  const trimmed = modelLabel?.trim();
  return trimmed ? trimmed : null;
}

/** Display-only label for run metadata; never used to build `--model`. */
function describeClaudeModelLabel(modelLabel: string | null): string {
  const trimmed = modelLabel?.trim();
  return trimmed ? trimmed : DEFAULT_MODEL_LABEL;
}

function runClaudePrint(
  config: ClaudeCliProviderConfig,
  input: ModelProviderInput,
): Promise<string> {
  const args = ["--print", "--output-format", "text"];
  const modelArgument = resolveClaudeModelArgument(config.modelLabel);
  if (modelArgument) {
    args.push("--model", modelArgument);
  }

  return new Promise((resolve, reject) => {
    const request = toSpawnRequest(config.commandPath, args);
    const child = spawn(request.command, request.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(new ClaudeCliProviderError("Claude CLI command timed out"));
    }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      input.onProgress?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new ClaudeCliProviderError(`Claude CLI failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(
          new ClaudeCliProviderError(
            `Claude CLI exited with code ${code}: ${stderr.trim() || "no stderr"}`,
          ),
        );
        return;
      }

      const text = stdout.trim();
      if (!text) {
        reject(new ClaudeCliProviderError("Claude CLI returned an empty response"));
        return;
      }
      resolve(text);
    });

    child.stdin.end(input.prompt);
  });
}

function toSpawnRequest(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/c", command, ...args],
    };
  }

  return { command, args };
}
