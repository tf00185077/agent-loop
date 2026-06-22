import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeCodexModelLabel, resolveCodexModelArgument } from "../domain/index.js";
import type { ModelProvider, ModelProviderInput, ModelProviderOutput } from "./model-provider.js";

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

  const args = ["exec", "--skip-git-repo-check", "--output-last-message", outputPath];
  const modelArgument = resolveCodexModelArgument(config.modelLabel);
  if (modelArgument) {
    args.push("--model", modelArgument);
  }
  args.push("-");

  try {
    const { code, stderr } = await spawnCodex(
      config.commandPath,
      args,
      input.prompt,
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (code !== 0) {
      throw new CodexCliProviderError(
        `Codex CLI exited with code ${code}: ${stderr.trim() || "no stderr"}`,
      );
    }

    const text = (await readFile(outputPath, "utf8")).trim();
    if (!text) {
      throw new CodexCliProviderError("Codex CLI returned an empty response");
    }
    return text;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function spawnCodex(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const request = toSpawnRequest(command, args);
    const child = spawn(request.command, request.args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new CodexCliProviderError("Codex CLI command timed out"));
    }, timeoutMs);

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
      resolve({ code, stderr });
    });
    child.stdin.end(stdin);
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
