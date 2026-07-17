import { spawn, type ChildProcess } from "node:child_process";

/**
 * Best-effort termination of a spawned CLI and its whole descendant tree.
 *
 * `child.kill()` alone is not enough on Windows: provider CLIs are often
 * launched through a shim (cmd/npm wrapper), and killing the wrapper leaves
 * the real binary running — observed live as codex.exe processes surviving a
 * session cancel and continuing to consume tokens. `taskkill /T /F` kills the
 * tree by pid. Never throws; a teardown failure must not take down the
 * backend.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => undefined);
      // Also signal the direct child in case taskkill is unavailable.
      child.kill();
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Already-exited or inaccessible process: nothing safer to do.
  }
}
