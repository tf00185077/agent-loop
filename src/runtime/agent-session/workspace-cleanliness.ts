import { isAbsolute, resolve } from "node:path";

/**
 * Workspace cleanliness that disregards the runtime's own database files.
 *
 * Every git-cleanliness gate runs `git status --porcelain` in the goal's
 * supervisor workspace and treats any output as dirty. The runtime writes its
 * own committed database (`data/auto-agent.sqlite` + sidecars) into that repo,
 * so a goal running inside the auto-agent repo is always "dirty". These helpers
 * judge cleanliness after excluding the runtime database files by absolute path,
 * so worktrees (which never contain the DB) are unaffected.
 */

/** One parsed porcelain entry: its 2-char status and the affected path. */
export interface PorcelainEntry {
  status: string;
  /** Repo-relative path (rename target for `R` lines), forward-slashed. */
  path: string;
}

export function parsePorcelain(stdout: string | undefined): PorcelainEntry[] {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.length >= 4)
    .map((line) => {
      const status = line.slice(0, 2);
      let rest = line.slice(3).trim();
      // Rename/copy lines are `old -> new`; the affected path is the target.
      const arrow = rest.indexOf(" -> ");
      if (arrow !== -1) rest = rest.slice(arrow + 4);
      const path = rest.replace(/^"|"$/g, "").replace(/\\/g, "/");
      return { status, path };
    });
}

function toAbsolute(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * Porcelain entries that remain after dropping any whose absolute path is one of
 * the ignored files. These are the entries that genuinely make a workspace dirty.
 */
export function significantStatusEntries(
  stdout: string | undefined,
  cwd: string,
  ignoredAbsPaths: readonly string[],
): PorcelainEntry[] {
  if (ignoredAbsPaths.length === 0) {
    return parsePorcelain(stdout);
  }
  const ignored = new Set(ignoredAbsPaths.map((p) => resolve(p)));
  return parsePorcelain(stdout).filter((entry) => !ignored.has(toAbsolute(cwd, entry.path)));
}

/** True when the workspace has no pending changes other than the ignored files. */
export function isWorkspaceStatusClean(
  stdout: string | undefined,
  cwd: string,
  ignoredAbsPaths: readonly string[],
): boolean {
  return significantStatusEntries(stdout, cwd, ignoredAbsPaths).length === 0;
}

/**
 * Porcelain summary with the ignored files removed, for durable "dirty" safe
 * reasons so they never list the runtime database.
 */
export function filteredStatusSummary(
  stdout: string | undefined,
  cwd: string,
  ignoredAbsPaths: readonly string[],
): string {
  return significantStatusEntries(stdout, cwd, ignoredAbsPaths)
    .map((entry) => `${entry.status} ${entry.path}`)
    .join("\n");
}

/**
 * The runtime database files to exclude from workspace cleanliness: the DB file
 * itself plus its `-wal`/`-shm`/`-journal` sidecars, as absolute paths. Empty
 * for an absent or in-memory database.
 */
export function runtimeDatabaseIgnorePaths(dbPath: string | undefined): string[] {
  if (!dbPath || dbPath === ":memory:") return [];
  const base = resolve(dbPath);
  return [base, `${base}-wal`, `${base}-shm`, `${base}-journal`];
}
