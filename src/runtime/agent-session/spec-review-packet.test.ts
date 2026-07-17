import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildSpecReviewPacket } from "./spec-review-packet.js";

function createChangeFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "auto-agent-spec-review-packet-"));
  const changeRoot = join(cwd, "openspec", "changes", "change-one");
  mkdirSync(join(changeRoot, "specs", "secondary"), { recursive: true });
  mkdirSync(join(changeRoot, "specs", "core"), { recursive: true });
  writeFileSync(
    join(changeRoot, "proposal.md"),
    `# Proposal\n\n${"A bounded proposal body. ".repeat(10)}\n`,
    "utf8",
  );
  writeFileSync(join(changeRoot, "specs", "secondary", "spec.md"), "# Secondary\n", "utf8");
  writeFileSync(join(changeRoot, "specs", "core", "spec.md"), "# Core\n", "utf8");
  writeFileSync(join(changeRoot, "specs", "core", "ignored.json"), "{}", "utf8");
  writeFileSync(join(changeRoot, "tasks.md"), "- [ ] Implement\n", "utf8");
  return cwd;
}

test("projects OpenSpec markdown artifacts in deterministic review order", () => {
  const cwd = createChangeFixture();

  const packet = buildSpecReviewPacket({ cwd, changeId: "change-one" });

  assert.ok(packet.indexOf("proposal.md") < packet.indexOf("specs/core/spec.md"));
  assert.ok(packet.indexOf("specs/core/spec.md") < packet.indexOf("specs/secondary/spec.md"));
  assert.ok(packet.indexOf("specs/secondary/spec.md") < packet.indexOf("tasks.md"));
  assert.match(packet, /## File: proposal\.md/);
  assert.match(packet, /## File: specs\/core\/spec\.md/);
  assert.match(packet, /## File: tasks\.md/);
  assert.doesNotMatch(packet, /ignored\.json/);
});

test("bounds a review packet with a stable truncation marker", () => {
  const cwd = createChangeFixture();

  const packet = buildSpecReviewPacket({ cwd, changeId: "change-one", maxChars: 180 });

  assert.equal(packet.length, 180);
  assert.match(packet, /\[review packet truncated\]$/);
});

test("rejects change ids that can escape the OpenSpec changes directory", () => {
  const cwd = createChangeFixture();

  for (const changeId of ["../outside", resolve(cwd, "absolute-change")]) {
    assert.throws(
      () => buildSpecReviewPacket({ cwd, changeId }),
      { name: "RangeError", message: /changeId/ },
      `expected ${changeId} to be rejected`,
    );
  }
});

test("rejects empty, special, and separator-containing change ids", () => {
  const cwd = createChangeFixture();

  for (const changeId of ["", ".", "..", "nested/change", "nested\\change"]) {
    assert.throws(() => buildSpecReviewPacket({ cwd, changeId }), RangeError);
  }
});

test("allows safe single-segment change ids containing punctuation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "auto-agent-spec-review-safe-id-"));
  const changeRoot = join(cwd, "openspec", "changes", "..safe_id-1.0");
  mkdirSync(changeRoot, { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Safe ID", "utf8");

  const packet = buildSpecReviewPacket({ cwd, changeId: "..safe_id-1.0" });

  assert.match(packet, /# Safe ID/);
});

test("rejects projected files whose symlinks escape the change root", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "auto-agent-spec-review-symlink-"));
  const changeRoot = join(cwd, "openspec", "changes", "change-one");
  const outside = join(cwd, "outside.md");
  mkdirSync(join(changeRoot, "specs", "core"), { recursive: true });
  writeFileSync(outside, "outside", "utf8");

  try {
    symlinkSync(outside, join(changeRoot, "proposal.md"), "file");
    symlinkSync(outside, join(changeRoot, "specs", "core", "spec.md"), "file");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      t.skip(`file symlinks are not supported in this environment (${code})`);
      return;
    }
    throw error;
  }

  assert.throws(() => buildSpecReviewPacket({ cwd, changeId: "change-one" }), /outside change root/i);
});

test("sorts normalized relative spec paths before projecting them", () => {
  const cwd = mkdtempSync(join(tmpdir(), "auto-agent-spec-review-order-"));
  const specsRoot = join(cwd, "openspec", "changes", "change-one", "specs");
  mkdirSync(join(specsRoot, "a"), { recursive: true });
  mkdirSync(join(specsRoot, "a0"), { recursive: true });
  writeFileSync(join(specsRoot, "a", "spec.md"), "# A", "utf8");
  writeFileSync(join(specsRoot, "a0", "spec.md"), "# A0", "utf8");

  const packet = buildSpecReviewPacket({ cwd, changeId: "change-one" });

  assert.ok(packet.indexOf("specs/a/spec.md") < packet.indexOf("specs/a0/spec.md"));
});

test("validates maxChars and never exceeds short positive limits", () => {
  const cwd = createChangeFixture();
  const marker = "\n\n[review packet truncated]";

  assert.throws(() => buildSpecReviewPacket({ cwd, changeId: "change-one", maxChars: -1 }), RangeError);
  assert.throws(() => buildSpecReviewPacket({ cwd, changeId: "change-one", maxChars: 1.5 }), RangeError);
  assert.equal(buildSpecReviewPacket({ cwd, changeId: "change-one", maxChars: 0 }), "");
  for (const maxChars of [1, 10, marker.length - 1]) {
    const packet = buildSpecReviewPacket({ cwd, changeId: "change-one", maxChars });
    assert.equal(packet, marker.slice(0, maxChars));
    assert.ok(packet.length <= maxChars);
  }
});
