import { spawn } from "node:child_process";

import { killProcessTree } from "../providers/process-tree.js";

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_CHECK_OUTPUT_CHARS = 2_000;

export interface CheckRunResult {
  /** Null when the command never produced an exit code (spawn failure or timeout). */
  exitCode: number | null;
  durationMs: number;
  /** Combined stdout+stderr, capped; the caller sanitizes before persisting. */
  outputSummary: string;
  failedToRun: boolean;
}

export interface CheckRunner {
  run(input: { cwd: string; command: string; timeoutMs: number }): Promise<CheckRunResult>;
}

/**
 * Backend-owned acceptance-check execution: one shell command per run,
 * confined to the given worktree, torn down with the whole process tree on
 * timeout. Never throws — a check that cannot run reports failedToRun.
 */
export function createShellCheckRunner(): CheckRunner {
  return {
    run(input) {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        let output = "";
        let settled = false;
        const settle = (result: Omit<CheckRunResult, "durationMs">) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({ ...result, durationMs: Date.now() - startedAt });
        };

        let child;
        try {
          child = spawn(input.command, { cwd: input.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        } catch {
          settle({ exitCode: null, outputSummary: "", failedToRun: true });
          return;
        }
        const timeout = setTimeout(() => {
          killProcessTree(child);
          // Destroy the pipes explicitly: if tree teardown is blocked (e.g. a
          // sandbox denying taskkill), an orphaned descendant holding stdout
          // must not keep this process's event loop alive forever.
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({
            exitCode: null,
            outputSummary: truncate(`${output}\n[check timed out after ${input.timeoutMs}ms]`),
            failedToRun: true,
          });
        }, input.timeoutMs);

        const collect = (chunk: unknown) => {
          if (output.length < MAX_CHECK_OUTPUT_CHARS * 4) output += String(chunk);
        };
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", collect);
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", collect);
        child.on("error", (err) => {
          settle({ exitCode: null, outputSummary: truncate(err.message), failedToRun: true });
        });
        child.on("close", (code) => {
          settle({ exitCode: code, outputSummary: truncate(output), failedToRun: code === null });
        });
      });
    },
  };
}

function truncate(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= MAX_CHECK_OUTPUT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_CHECK_OUTPUT_CHARS)}\n[check output truncated]`;
}
