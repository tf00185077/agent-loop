import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { ProviderStatus } from "../domain/index.js";
import { sanitizeProviderStatus } from "../domain/index.js";

const connectionTestPrompt = "Reply with exactly: codex-local-connection-ok";

export interface CodexLocalConnectionTestResult {
  status: ProviderStatus;
}

export interface CodexLocalConnectionTestOptions {
  codexCommandPath: string;
  modelLabel: string;
  wrapperCommand?: string;
  wrapperArgs?: string[];
  timeoutMs?: number;
  checkedAt?: () => string;
  runCommand?: CodexLocalConnectionRunner;
}

export type CodexLocalConnectionRunner = (
  request: CodexLocalConnectionCommandRequest,
) => Promise<string>;

export interface CodexLocalConnectionCommandRequest {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  timeoutMs: number;
  input: {
    goal: {
      id: string;
      title: string;
      description: string;
    };
    prompt: string;
  };
}

export async function testCodexLocalConnection(
  options: CodexLocalConnectionTestOptions,
): Promise<CodexLocalConnectionTestResult> {
  const checkedAt = (options.checkedAt ?? (() => new Date().toISOString()))();
  const request = toConnectionTestRequest(options);
  const runCommand = options.runCommand ?? runLocalAgentWrapper;

  try {
    const stdout = await runCommand(request);
    assertWrapperReturnedText(stdout);
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
    command: options.wrapperCommand ?? process.execPath,
    args: options.wrapperArgs ?? [resolve("scripts", "codex-local-agent-wrapper.mjs")],
    env: {
      ...process.env,
      AUTO_AGENT_CODEX_COMMAND_PATH: options.codexCommandPath,
      AUTO_AGENT_OPENAI_LOCAL_MODEL: options.modelLabel,
    },
    timeoutMs: options.timeoutMs ?? 30_000,
    input: {
      goal: {
        id: "codex-local-connection-test",
        title: "Codex Local connection test",
        description: "Verify the configured Codex Local wrapper can return a response.",
      },
      prompt: connectionTestPrompt,
    },
  };
}

function assertWrapperReturnedText(stdout: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Codex Local wrapper output was not JSON");
  }

  if (!isRecord(parsed) || typeof parsed.text !== "string" || !parsed.text.trim()) {
    throw new Error("Codex Local wrapper output did not include response text");
  }
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

function runLocalAgentWrapper(request: CodexLocalConnectionCommandRequest): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(request.command, request.args, {
      env: request.env,
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
      reject(new Error("Codex Local wrapper command timed out"));
    }, request.timeoutMs);

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
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`Codex Local wrapper exited with code ${code}: ${stderr.trim() || "no stderr"}`));
        return;
      }

      resolvePromise(stdout);
    });

    child.stdin.end(`${JSON.stringify(request.input)}\n`);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
