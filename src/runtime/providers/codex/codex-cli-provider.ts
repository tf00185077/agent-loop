import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeCodexModelLabel, resolveCodexModelArgument } from "../../../domain/index.js";
import type { ModelProvider, ModelProviderInput, ModelProviderOutput } from "../model-provider.js";
import { createCodexJsonlParser } from "./codex-jsonl-parser.js";

export interface CodexCliProviderConfig {
  /** Resolved Codex CLI command path (absolute) used to spawn Codex directly. */
  commandPath: string;
  /** Saved model label; drives both the `--model` argument and run metadata. */
  modelLabel: string | null;
  /** Hard timeout for a single Codex invocation. Defaults to 120s. */
  timeoutMs?: number;
}

export interface CodexCliProviderDeps {
  config: CodexCliProviderConfig;
}

const PROVIDER_NAME = "codex-cli";
const DEFAULT_TIMEOUT_MS = 120_000;

export class CodexCliProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCliProviderError";
  }
}

export function createCodexCliProvider(deps: CodexCliProviderDeps): ModelProvider {
  const config = deps.config;
  const metadata = {
    provider: PROVIDER_NAME,
    model: describeCodexModelLabel(config.modelLabel),
  };

  return {
    metadata,
    async complete(input) {
      if (!config.commandPath?.trim()) {
        throw new CodexCliProviderError("Codex command path is required");
      }

      const text = await runCodexExec(config, input);

      return {
        text,
        metadata,
        conversationState: undefined,
      } satisfies ModelProviderOutput;
    },
  };
}

async function runCodexExec(
  config: CodexCliProviderConfig,
  input: ModelProviderInput,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "auto-agent-codex-provider-"));
  const outputPath = join(tempDir, "last-message.txt");

  try {
    const jsonResult = await spawnCodex(
      config.commandPath,
      buildCodexExecArgs(config, outputPath, { json: true }),
      input.prompt,
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      {
        commandName: safeCommandName(config.commandPath),
        model: describeCodexModelLabel(config.modelLabel),
      },
      { onProgress: input.onProgress, parseJsonl: true },
    );
    if (jsonResult.code === 0) {
      const text = jsonResult.finalMessage ?? (await readLastMessage(outputPath));
      if (!text) {
        throw new CodexCliProviderError("Codex CLI returned an empty response");
      }
      return text;
    }

    if (!isJsonModeUnavailable(jsonResult.stderr)) {
      throw new CodexCliProviderError(
        `Codex CLI exited with code ${jsonResult.code}: ${jsonResult.stderr.trim() || "no stderr"}`,
      );
    }

    input.onProgress?.({
      kind: "progress",
      message: "Codex JSONL progress unavailable; using last-message fallback",
      metadata: { source: "provider", rawEventType: "json-unavailable" },
    });
    const legacyResult = await spawnCodex(
      config.commandPath,
      buildCodexExecArgs(config, outputPath, { json: false }),
      input.prompt,
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      {
        commandName: safeCommandName(config.commandPath),
        model: describeCodexModelLabel(config.modelLabel),
      },
      { onProgress: input.onProgress, parseJsonl: false },
    );
    if (legacyResult.code !== 0) {
      throw new CodexCliProviderError(
        `Codex CLI exited with code ${legacyResult.code}: ${legacyResult.stderr.trim() || "no stderr"}`,
      );
    }

    const text = await readLastMessage(outputPath);
    if (!text) {
      throw new CodexCliProviderError("Codex CLI returned an empty response");
    }
    return text;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildCodexExecArgs(
  config: CodexCliProviderConfig,
  outputPath: string,
  options: { json: boolean },
): string[] {
  const args = ["exec", "--skip-git-repo-check"];
  if (options.json) args.push("--json");
  args.push("--output-last-message", outputPath);
  const modelArgument = resolveCodexModelArgument(config.modelLabel);
  if (modelArgument) {
    args.push("--model", modelArgument);
  }
  args.push("-");
  return args;
}

async function readLastMessage(outputPath: string): Promise<string | null> {
  try {
    const text = (await readFile(outputPath, "utf8")).trim();
    return text || null;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function spawnCodex(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  diagnostics: { commandName: string; model: string },
  options: {
    onProgress?: ModelProviderInput["onProgress"];
    parseJsonl: boolean;
  },
): Promise<{ code: number | null; stderr: string; finalMessage?: string; errorMessage?: string }> {
  return new Promise((resolve, reject) => {
    const request = toSpawnRequest(command, args);
    const child = spawn(request.command, request.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let finalMessage: string | undefined;
    let errorMessage: string | undefined;
    const parser = options.parseJsonl ? createCodexJsonlParser() : null;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new CodexCliProviderError(formatTimeoutMessage(timeoutMs, diagnostics, stderr)));
    }, timeoutMs);

    // Codex normally ignores stdout in favor of --output-last-message, but
    // it may still print useful progress text; forward it without relying
    // on it for the final result.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!parser) {
        options.onProgress?.(chunk);
        return;
      }
      for (const result of parser.push(chunk)) {
        for (const observation of result.observations) options.onProgress?.(observation);
        finalMessage = result.finalMessage ?? finalMessage;
        errorMessage = result.errorMessage ?? errorMessage;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new CodexCliProviderError(`Codex CLI failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (parser) {
        for (const result of parser.flush()) {
          for (const observation of result.observations) options.onProgress?.(observation);
          finalMessage = result.finalMessage ?? finalMessage;
          errorMessage = result.errorMessage ?? errorMessage;
        }
      }
      resolve({ code, stderr, finalMessage, errorMessage });
    });
    child.stdin.end(stdin);
  });
}

function isJsonModeUnavailable(stderr: string): boolean {
  return /unknown (?:option|flag).*--json|unexpected (?:argument|option).*--json|unrecognized (?:option|flag).*--json|cannot be used with --output-last-message/i.test(
    stderr,
  );
}

function formatTimeoutMessage(
  timeoutMs: number,
  diagnostics: { commandName: string; model: string },
  stderr: string,
): string {
  const stderrTail = stderr.trim().slice(-500);
  const base = `Codex CLI command timed out after ${timeoutMs}ms (model: ${diagnostics.model}, command: ${diagnostics.commandName})`;
  return stderrTail ? `${base}. Last stderr: ${stderrTail}` : base;
}

function safeCommandName(command: string): string {
  const leaf = command.trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "codex";
  return leaf.replace(/\s+--(?:api-key|token|access-token)\s+\S+/gi, "");
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
