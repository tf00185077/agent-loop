import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface ArchiveManifestIdentityProof {
  ok: boolean;
  filesystemDigest: string | null;
  commitTreeDigest: string | null;
}

/** Canonical archive digest: file content keyed only by its slash-normalized path below the archive root. */
export function computeArchiveManifestDigest(root: string): string {
  const hash = createHash("sha256");
  for (const path of listArchiveFiles(root).sort()) {
    const rel = relative(root, path).replace(/\\/g, "/");
    const content = readFileSync(path);
    hash.update(`${rel.length}:${rel}:${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/** Applies the same canonical mapping to files stored below the dated target in one Git commit tree. */
export function computeArchiveCommitTreeManifestDigest(
  cwd: string,
  commitSha: string,
  targetRelative: string,
): string | null {
  const normalizedTarget = targetRelative.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const listed = spawnSync("git", ["ls-tree", "-r", "--name-only", commitSha, "--", normalizedTarget], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) return null;
  const paths = String(listed.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).sort();
  if (paths.length === 0) return null;
  const hash = createHash("sha256");
  for (const path of paths) {
    if (path !== normalizedTarget && !path.startsWith(`${normalizedTarget}/`)) return null;
    const shown = spawnSync("git", ["show", `${commitSha}:${path}`], {
      cwd,
      encoding: null,
      windowsHide: true,
    });
    if (shown.status !== 0) return null;
    const content = Buffer.isBuffer(shown.stdout) ? shown.stdout : Buffer.from(shown.stdout ?? "");
    const rel = path.slice(normalizedTarget.length).replace(/^\//, "");
    hash.update(`${rel.length}:${rel}:${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/** Shared finalization/replay proof for the current dated target and the uniquely selected archive commit. */
export function proveArchiveManifestIdentity(input: {
  cwd: string;
  targetPath: string;
  targetRelative: string;
  archiveCommitSha: string;
  expectedDigest: string;
}): ArchiveManifestIdentityProof {
  let filesystemDigest: string | null = null;
  try {
    filesystemDigest = computeArchiveManifestDigest(input.targetPath);
  } catch {
    // Missing, raced, or unreadable targets are proof failures.
  }
  const commitTreeDigest = computeArchiveCommitTreeManifestDigest(
    input.cwd,
    input.archiveCommitSha,
    input.targetRelative,
  );
  return {
    ok: filesystemDigest === input.expectedDigest && commitTreeDigest === input.expectedDigest,
    filesystemDigest,
    commitTreeDigest,
  };
}

function listArchiveFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listArchiveFiles(path));
    else files.push(path);
  }
  return files;
}
