import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_CHARS = 12_000;
const TRUNCATION_MARKER = "\n\n[review packet truncated]";

function listMarkdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(path);
      return (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md") ? [path] : [];
    });
}

function assertSafeChangeId(changeId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(changeId) || changeId === "." || changeId === "..") {
    throw new RangeError("changeId must be a safe single path segment.");
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const pathFromRoot = relative(root, candidate);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new RangeError(`${label} resolves outside change root.`);
  }
}

function validateMaxChars(maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative integer.");
  }
}

export function buildSpecReviewPacket(input: {
  cwd: string;
  changeId: string;
  maxChars?: number;
}): string {
  assertSafeChangeId(input.changeId);
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  validateMaxChars(maxChars);

  const changesRoot = resolve(input.cwd, "openspec", "changes");
  const root = resolve(changesRoot, input.changeId);
  assertContained(changesRoot, root, "changeId");
  if (!existsSync(root)) return "";

  const changesRootReal = realpathSync(changesRoot);
  const rootReal = realpathSync(root);
  assertContained(changesRootReal, rootReal, "changeId");
  const relativeFiles = [
    "proposal.md",
    ...listMarkdownFiles(resolve(root, "specs"))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .sort(),
    "tasks.md",
  ];
  const body = relativeFiles
    .filter((path) => existsSync(resolve(root, path)))
    .map((path) => {
      const fileReal = realpathSync(resolve(root, path));
      assertContained(rootReal, fileReal, `Projected file ${path}`);
      if (!statSync(fileReal).isFile()) return null;
      return `## File: ${path}\n\n${readFileSync(fileReal, "utf8").trim()}`;
    })
    .filter((section): section is string => section !== null)
    .join("\n\n");
  if (body.length <= maxChars) return body;
  if (maxChars < TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars);
  return `${body.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}
