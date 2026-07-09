import assert from "node:assert/strict";
import test from "node:test";

import { extractControlBlocks } from "./control-block.js";

const fence = "```";

function block(body: string): string {
  return `${fence}auto-agent-control\n${body}\n${fence}`;
}

test("returns prose unchanged when no control block is present", () => {
  const result = extractControlBlocks("Just a normal progress update.");

  assert.deepEqual(result.blocks, []);
  assert.equal(result.strippedText, "Just a normal progress update.");
});

test("extracts a control block and strips it from the text", () => {
  const payload = { type: "managed_delegation.complete", summary: "All tasks done." };
  const text = `The goal is finished.\n\n${block(JSON.stringify(payload))}\n\nThanks.`;

  const result = extractControlBlocks(text);

  assert.equal(result.blocks.length, 1);
  assert.deepEqual(result.blocks[0]?.payload, payload);
  assert.equal(result.blocks[0]?.parseError, undefined);
  assert.equal(result.strippedText, "The goal is finished.\n\nThanks.");
  assert.ok(!result.strippedText.includes("auto-agent-control"));
});

test("extracts multiple control blocks in document order", () => {
  const first = { type: "managed_delegation.task_list", tasks: [{ id: "task-1", title: "Do it" }] };
  const second = {
    type: "managed_delegation.request",
    role: "worker",
    taskId: "task-1",
    prompt: "Do it now.",
  };
  const text = `${block(JSON.stringify(first))}\nplanning...\n${block(JSON.stringify(second))}`;

  const result = extractControlBlocks(text);

  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks[0]?.payload, first);
  assert.deepEqual(result.blocks[1]?.payload, second);
  assert.equal(result.strippedText, "planning...");
});

test("reports malformed JSON as a parse error without dropping surrounding text", () => {
  const text = `Before.\n${block("{not json")}\nAfter.`;

  const result = extractControlBlocks(text);

  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0]?.payload, undefined);
  assert.equal(typeof result.blocks[0]?.parseError, "string");
  assert.equal(result.strippedText, "Before.\nAfter.");
});

test("ignores ordinary code fences that are not control blocks", () => {
  const text = `Run this:\n${fence}bash\necho hi\n${fence}\nDone.`;

  const result = extractControlBlocks(text);

  assert.deepEqual(result.blocks, []);
  assert.equal(result.strippedText, text);
});

test("collapses leftover blank lines after stripping a block", () => {
  const payload = { type: "managed_delegation.complete", summary: "ok" };
  const text = `Line one.\n\n\n${block(JSON.stringify(payload))}\n\n\nLine two.`;

  const result = extractControlBlocks(text);

  assert.equal(result.strippedText, "Line one.\n\nLine two.");
});
