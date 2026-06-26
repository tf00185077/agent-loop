import assert from "node:assert/strict";
import test from "node:test";

import { createCodexJsonlParser } from "./codex-jsonl-parser.js";

test("parses Codex JSONL lifecycle command message error and unknown lines from fixtures", () => {
  const parser = createCodexJsonlParser();

  const results = parser.push(
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started", turn_id: "turn-1" }),
      JSON.stringify({
        type: "item.started",
        item: { id: "cmd-1", type: "command", command: "npm test" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command",
          command: "npm test",
          exit_code: 0,
          stdout: "ok",
          stderr: "",
        },
      }),
      JSON.stringify({
        type: "item.failed",
        item: { id: "cmd-2", type: "command", command: "npm run build", error: "boom" },
      }),
      JSON.stringify({ type: "agent_message", message: "Final answer" }),
      JSON.stringify({ type: "error", message: "Codex failed" }),
      JSON.stringify({ type: "future.event", payload: { raw: "ignored" } }),
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    results.flatMap((result) => result.observations.map((observation) => observation.kind)),
    [
      "progress",
      "progress",
      "command.started",
      "command.completed",
      "command.failed",
      "progress",
      "command.failed",
    ],
  );
  assert.deepEqual(results[0]?.observations[0]?.metadata, {
    source: "jsonl",
    rawEventType: "thread.started",
  });
  assert.deepEqual(results[2]?.observations[0]?.command, {
    label: "npm test",
    status: "started",
  });
  assert.deepEqual(results[3]?.observations[0]?.command, {
    label: "npm test",
    status: "completed",
    exitCode: 0,
    stdoutTail: "ok",
  });
  assert.equal(results.find((result) => result.finalMessage)?.finalMessage, "Final answer");
  assert.equal(results.find((result) => result.errorMessage)?.errorMessage, "Codex failed");
});

test("parses partial JSONL chunks incrementally and ignores malformed lines safely", () => {
  const parser = createCodexJsonlParser();

  assert.deepEqual(parser.push('{"type":"agent_message","message":"hel'), []);
  assert.deepEqual(parser.push('lo"}\nnot-json\n'), [
    {
      observations: [
        {
          kind: "progress",
          message: "hello",
          metadata: { source: "jsonl", rawEventType: "agent_message" },
        },
      ],
      finalMessage: "hello",
    },
  ]);
  assert.deepEqual(parser.flush(), []);
});
