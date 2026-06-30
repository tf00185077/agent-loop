import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeCodexModelLabel, resolveCodexModelArgument } from "../../../domain/index.js";
import type { ModelProvider, ModelProviderInput, ModelProviderOutput } from "../model-provider.js";
import { createCodexJsonlParser, type CodexJsonlParsedResult } from "./codex-jsonl-parser.js";

export interface CodexCliProviderConfig {
  /** Resolved Codex CLI command path (absolute) used to spawn Codex directly. */
  commandPath: string;
  /** Saved model label; drives both the `--model` argument and run metadata. */
  modelLabel: string | null;
  /** Hard timeout for a single Codex invocation. Defaults to 120s. */
  timeoutMs?: number;
  /** Enables true Codex resume when a prior Codex session id is available. */
  resumeEnabled?: boolean;
}

export interface CodexCliProviderDeps {
  config: CodexCliProviderConfig;
}

const PROVIDER_NAME = "codex-cli";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CodexConversationState {
  provider: typeof PROVIDER_NAME;
  sessionId: string;
  cwd: string;
  modelLabel: string;
  invocation: {
    json: true;
    resumeUsed: boolean;
    fallbackReason?: string;
  };
  capabilities: {
    trueResume: boolean;
    continuationFallback: boolean;
    managedHome: false;
    jsonlEvents: true;
  };
}

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
  const capabilities = codexCapabilities(config);

  return {
    metadata,
    capabilities,
    async complete(input) {
      if (!config.commandPath?.trim()) {
        throw new CodexCliProviderError("Codex command path is required");
      }

      const result = await runCodexExec(config, input);

      return {
        text: result.text,
        metadata,
        conversationState: result.conversationState,
      } satisfies ModelProviderOutput;
    },
  };
}

async function runCodexExec(
  config: CodexCliProviderConfig,
  input: ModelProviderInput,
): Promise<{ text: string; conversationState?: CodexConversationState }> {
  const tempDir = await mkdtemp(join(tmpdir(), "auto-agent-codex-provider-"));
  const outputPath = join(tempDir, "last-message.txt");
  const priorState = parseCodexConversationState(input.conversationState);
  const resumeEnabled = config.resumeEnabled !== false;
  const shouldResume = Boolean(
    input.continuation?.mode !== "fresh" &&
      resumeEnabled &&
      priorState?.sessionId &&
      priorState.capabilities.trueResume,
  );
  let fallbackReason: string | undefined;

  try {
    const jsonResult = await spawnCodex(
      config.commandPath,
      buildCodexExecArgs(config, outputPath, {
        json: true,
        resumeSessionId: shouldResume ? priorState?.sessionId : undefined,
      }),
      input.prompt,
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      {
        commandName: safeCommandName(config.commandPath),
        model: describeCodexModelLabel(config.modelLabel),
      },
      { onProgress: input.onProgress, parseJsonl: true },
    );
    let successfulJsonResult = jsonResult;
    if (jsonResult.code !== 0 && shouldResume && isResumeUnavailable(jsonResult.stderr)) {
      fallbackReason = "Codex resume was unavailable for the stored session; started a fresh continuation.";
      input.onProgress?.({
        kind: "progress",
        message: fallbackReason,
        metadata: { source: "provider", rawEventType: "resume-fallback" },
      });
      successfulJsonResult = await spawnCodex(
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
    }

    if (successfulJsonResult.code === 0) {
      const text = successfulJsonResult.finalMessage ?? (await readLastMessage(outputPath));
      if (!text) {
        throw new CodexCliProviderError("Codex CLI returned an empty response");
      }
      return {
        text,
        conversationState: buildConversationState(config, successfulJsonResult.session, priorState, {
          resumeUsed: shouldResume && !fallbackReason,
          fallbackReason,
        }),
      };
    }

    if (!isJsonModeUnavailable(successfulJsonResult.stderr)) {
      throw new CodexCliProviderError(classifyCodexFailure(successfulJsonResult.code, successfulJsonResult.stderr));
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
      throw new CodexCliProviderError(classifyCodexFailure(legacyResult.code, legacyResult.stderr));
    }

    const text = await readLastMessage(outputPath);
    if (!text) {
      throw new CodexCliProviderError("Codex CLI returned an empty response");
    }
    return { text };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildCodexExecArgs(
  config: CodexCliProviderConfig,
  outputPath: string,
  options: { json: boolean; resumeSessionId?: string },
): string[] {
  const args = ["exec", "--skip-git-repo-check"];
  if (options.json) args.push("--json");
  args.push("--output-last-message", outputPath);
  const modelArgument = resolveCodexModelArgument(config.modelLabel);
  if (modelArgument) {
    args.push("--model", modelArgument);
  }
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId);
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
): Promise<{
  code: number | null;
  stderr: string;
  finalMessage?: string;
  errorMessage?: string;
  session?: CodexJsonlParsedResult["session"];
}> {
  return new Promise((resolve, reject) => {
    const request = toSpawnRequest(command, args);
    const child = spawn(request.command, request.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let finalMessage: string | undefined;
    let errorMessage: string | undefined;
    let session: CodexJsonlParsedResult["session"];
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
        session = result.session ?? session;
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
      reject(new CodexCliProviderError(classifyCodexStartupFailure(err)));
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
          session = result.session ?? session;
        }
      }
      resolve({ code, stderr, finalMessage, errorMessage, session });
    });
    child.stdin.end(stdin);
  });
}

function isJsonModeUnavailable(stderr: string): boolean {
  return /unknown (?:option|flag).*--json|unexpected (?:argument|option).*--json|unrecognized (?:option|flag).*--json|cannot be used with --output-last-message/i.test(
    stderr,
  );
}

function isResumeUnavailable(stderr: string): boolean {
  return /unknown session|session .*not found|resume .*unsupported|unknown (?:subcommand|command).*resume|unrecognized (?:subcommand|command).*resume/i.test(
    stderr,
  );
}

function classifyCodexStartupFailure(err: Error & Partial<NodeJS.ErrnoException>): string {
  const message = err.message || "unknown startup error";
  if (err.code === "ENOENT" || /ENOENT|not found|cannot find/i.test(message)) {
    return `Codex command is missing or unavailable: ${sanitizeDiagnostic(message)}`;
  }
  return `Codex CLI failed to start: ${sanitizeDiagnostic(message)}`;
}

function classifyCodexFailure(code: number | null, stderr: string): string {
  const safeStderr = sanitizeDiagnostic(stderr.trim() || "no stderr");
  if (isCodexAuthFailure(stderr)) {
    return `Codex authentication failed: ${safeStderr}`;
  }
  return `Codex CLI exited with code ${code ?? "unknown"}: ${safeStderr}`;
}

function isCodexAuthFailure(stderr: string): boolean {
  return /auth(?:entication)?|not logged in|login required|codex login|invalid api key|unauthorized|permission denied/i.test(
    stderr,
  );
}

function parseCodexConversationState(value: unknown): CodexConversationState | null {
  if (!isRecord(value)) return null;
  if (value.provider !== PROVIDER_NAME) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return null;
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  return {
    provider: PROVIDER_NAME,
    sessionId: value.sessionId.trim(),
    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : process.cwd(),
    modelLabel: typeof value.modelLabel === "string" ? value.modelLabel : describeCodexModelLabel(null),
    invocation: {
      json: true,
      resumeUsed: isRecord(value.invocation) && value.invocation.resumeUsed === true,
      fallbackReason:
        isRecord(value.invocation) && typeof value.invocation.fallbackReason === "string"
          ? value.invocation.fallbackReason
          : undefined,
    },
    capabilities: {
      trueResume: capabilities.trueResume === true,
      continuationFallback: capabilities.continuationFallback !== false,
      managedHome: false,
      jsonlEvents: true,
    },
  };
}

function buildConversationState(
  config: CodexCliProviderConfig,
  session: CodexJsonlParsedResult["session"],
  priorState: CodexConversationState | null,
  invocation: { resumeUsed: boolean; fallbackReason?: string },
): CodexConversationState | undefined {
  const sessionId = session?.sessionId ?? priorState?.sessionId;
  if (!sessionId) return undefined;
  return {
    provider: PROVIDER_NAME,
    sessionId,
    cwd: session?.cwd ?? priorState?.cwd ?? process.cwd(),
    modelLabel: describeCodexModelLabel(config.modelLabel),
    invocation: {
      json: true,
      resumeUsed: invocation.resumeUsed,
      fallbackReason: invocation.fallbackReason,
    },
      capabilities: {
      trueResume: config.resumeEnabled !== false,
      continuationFallback: true,
      managedHome: false,
      jsonlEvents: true,
    },
  };
}

function codexCapabilities(config: CodexCliProviderConfig): ModelProvider["capabilities"] {
  return {
    trueResume: config.resumeEnabled !== false,
    continuationFallback: true,
    managedHome: false,
    jsonlEvents: true,
  };
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

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/\s+--(api-key|token|access-token)\s+\S+/gi, " --$1 [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/\bhidden\b/gi, "[redacted]");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
