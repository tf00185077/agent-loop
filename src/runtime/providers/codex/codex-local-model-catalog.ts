import { spawn } from "node:child_process";

import type {
  CodexModelCatalogEntry,
  CodexModelCatalogResult,
  CodexModelCatalogSource,
} from "../../../domain/index.js";

/**
 * Visibility values that mark a catalog entry as selectable in a list. Any
 * other explicit visibility is treated as hidden/internal and filtered out.
 */
const SELECTABLE_VISIBILITY = new Set(["list", "listed", "public", "visible"]);

export interface CodexModelCatalogOptions {
  codexCommandPath: string;
  source?: CodexModelCatalogSource;
  catalogArgs?: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  checkedAt?: () => string;
  runCommand?: CodexModelCatalogRunner;
}

export type CodexModelCatalogRunner = (
  request: CodexModelCatalogCommandRequest,
) => Promise<string>;

export interface CodexModelCatalogCommandRequest {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

export async function loadCodexModelCatalog(
  options: CodexModelCatalogOptions,
): Promise<CodexModelCatalogResult> {
  const checkedAt = (options.checkedAt ?? (() => new Date().toISOString()))();
  const source = options.source ?? "manual";
  const runCommand = options.runCommand ?? runCodexCatalogCommand;

  const request: CodexModelCatalogCommandRequest = {
    command: options.codexCommandPath,
    args: options.catalogArgs ?? ["debug", "models"],
    env: { ...(options.env ?? process.env) },
    timeoutMs: options.timeoutMs ?? 15_000,
  };

  let stdout: string;
  try {
    stdout = await runCommand(request);
  } catch (err) {
    return unavailable(
      source,
      checkedAt,
      "Codex CLI model catalog lookup failed.",
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unavailable(
      source,
      checkedAt,
      "Codex CLI returned malformed model catalog output.",
      stdout,
    );
  }

  const models = extractModels(parsed);
  if (models.length === 0) {
    return {
      models: [],
      defaultModelSlug: null,
      source,
      status: {
        state: "empty",
        checkedAt,
        message: "No selectable Codex Local models were found.",
      },
    };
  }

  return {
    models,
    defaultModelSlug: models[0].slug,
    source,
    status: { state: "available", checkedAt, message: null },
  };
}

function unavailable(
  source: CodexModelCatalogSource,
  checkedAt: string,
  message: string,
  detail: string | null = null,
): CodexModelCatalogResult {
  return {
    models: [],
    defaultModelSlug: null,
    source,
    status: { state: "unavailable", checkedAt, message, detail: detail || null },
  };
}

function extractModels(parsed: unknown): CodexModelCatalogEntry[] {
  const rawEntries = toRawEntries(parsed);
  const mapped: CodexModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const raw of rawEntries) {
    if (!isRecord(raw)) continue;
    if (!isSelectable(raw)) continue;

    const slug = readString(raw, ["slug", "id", "name", "model"]);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    mapped.push({
      slug,
      displayName: readString(raw, ["display_name", "displayName", "label", "title"]) ?? slug,
      description: readString(raw, ["description", "summary", "subtitle"]) ?? null,
      priority: readNumber(raw, ["priority", "order", "sort_order", "rank"]) ?? Number.MAX_SAFE_INTEGER,
    });
  }

  return sortByPriority(mapped);
}

function toRawEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed)) {
    for (const key of ["models", "data", "entries"]) {
      const value = parsed[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function isSelectable(raw: Record<string, unknown>): boolean {
  if (raw.hidden === true) return false;
  if (raw.visible === false) return false;
  const visibility = typeof raw.visibility === "string" ? raw.visibility.toLowerCase() : null;
  if (visibility && !SELECTABLE_VISIBILITY.has(visibility)) return false;
  return true;
}

function sortByPriority(models: CodexModelCatalogEntry[]): CodexModelCatalogEntry[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => a.model.priority - b.model.priority || a.index - b.index)
    .map((entry) => entry.model);
}

function readString(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runCodexCatalogCommand(request: CodexModelCatalogCommandRequest): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(request.command, request.args, {
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Codex CLI model catalog command timed out"));
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
        reject(new Error(`Codex CLI model catalog command exited with code ${code}: ${stderr.trim() || "no stderr"}`));
        return;
      }

      resolvePromise(stdout);
    });
  });
}
