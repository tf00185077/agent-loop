import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { killProcessTree } from "./process-tree.js";

test("killProcessTree terminates a long-running child promptly", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  killProcessTree(child);

  const winner = await Promise.race([
    closed.then(() => "closed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  assert.equal(winner, "closed", "the child process must exit after killProcessTree");
});

test("killProcessTree terminates a shell-wrapped process tree", async () => {
  // Mirrors the CLI shim shape that leaked on Windows: a wrapper process whose
  // descendant does the actual work.
  const wrapped = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", `"${process.execPath}" -e "setInterval(() => {}, 1000);"`], {
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn("sh", ["-c", `"${process.execPath}" -e "setInterval(() => {}, 1000);"`], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => {
    wrapped.on("close", () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  killProcessTree(wrapped);

  const winner = await Promise.race([
    closed.then(() => "closed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  assert.equal(winner, "closed", "the wrapper must exit after killProcessTree");
});

test("killProcessTree is a safe no-op for an already-exited child", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0);"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  assert.doesNotThrow(() => killProcessTree(child));
});
