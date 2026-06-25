import type { ProviderStatus } from "../../../domain/index.js";
import { sanitizeProviderStatus } from "../../../domain/index.js";
import { createCodexCliProvider } from "./codex-cli-provider.js";
import type { ModelProviderInput } from "../model-provider.js";

const connectionTestPrompt = "Reply with exactly: codex-local-connection-ok";

export interface CodexLocalConnectionTestResult {
  status: ProviderStatus;
}

export interface CodexLocalConnectionTestOptions {
  codexCommandPath: string;
  modelLabel: string;
  timeoutMs?: number;
  checkedAt?: () => string;
  runConnection?: CodexLocalConnectionRunner;
}

export type CodexLocalConnectionRunner = (
  request: CodexLocalConnectionCommandRequest,
) => Promise<string>;

export interface CodexLocalConnectionCommandRequest {
  codexCommandPath: string;
  modelLabel: string;
  timeoutMs: number;
  input: ModelProviderInput;
}

export async function testCodexLocalConnection(
  options: CodexLocalConnectionTestOptions,
): Promise<CodexLocalConnectionTestResult> {
  const checkedAt = (options.checkedAt ?? (() => new Date().toISOString()))();
  const request = toConnectionTestRequest(options);
  const runConnection = options.runConnection ?? runCodexConnection;

  try {
    const text = await runConnection(request);
    if (!text.trim()) {
      throw new Error("Codex Local connection test returned an empty response");
    }
    return {
      status: {
        state: "connected",
        detected: true,
        checkedAt,
        message: "Codex Local connection test succeeded.",
      },
    };
  } catch (err) {
    return {
      status: classifyConnectionFailure(err, checkedAt),
    };
  }
}

function toConnectionTestRequest(
  options: CodexLocalConnectionTestOptions,
): CodexLocalConnectionCommandRequest {
  return {
    codexCommandPath: options.codexCommandPath,
    modelLabel: options.modelLabel,
    timeoutMs: options.timeoutMs ?? 30_000,
    input: {
      goal: {
        id: "codex-local-connection-test",
        title: "Codex Local connection test",
        description: "Verify the configured Codex Local provider can return a response.",
      },
      prompt: connectionTestPrompt,
    },
  };
}

function runCodexConnection(request: CodexLocalConnectionCommandRequest): Promise<string> {
  const provider = createCodexCliProvider({
    config: {
      commandPath: request.codexCommandPath,
      modelLabel: request.modelLabel,
      timeoutMs: request.timeoutMs,
    },
  });
  return provider.complete(request.input).then((output) => output.text);
}

function classifyConnectionFailure(err: unknown, checkedAt: string): ProviderStatus {
  const code = isErrnoException(err) ? err.code : undefined;
  const message = errorMessage(err);
  const lower = message.toLowerCase();

  if (code === "ENOENT" || lower.includes("enoent") || lower.includes("not found")) {
    return {
      state: "not_found",
      detected: false,
      checkedAt,
      message: "Codex Local command was not found. Check the saved command path.",
    };
  }

  if (
    lower.includes("codex login") ||
    lower.includes("not logged in") ||
    lower.includes("login required") ||
    lower.includes("authentication required") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid auth")
  ) {
    return {
      state: "login_required",
      detected: true,
      checkedAt,
      message: "Codex authentication is unavailable. Run codex login, then test again.",
    };
  }

  if (
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("eai_again")
  ) {
    return {
      state: "network_failure",
      detected: true,
      checkedAt,
      message: "Codex Local connection test failed because the network was unavailable.",
    };
  }

  return sanitizeProviderStatus({
    state: "command_failure",
    detected: true,
    checkedAt,
    message: `Codex Local connection test failed: ${message}`,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
