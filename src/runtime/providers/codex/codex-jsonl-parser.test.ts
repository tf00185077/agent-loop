import assert from "node:assert/strict";
import test from "node:test";

import { createCodexJsonlParser } from "./codex-jsonl-parser.js";

test("parses Codex JSONL lifecycle command message error and diagnostics from fixtures", () => {
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
      "not-json",
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
      "progress",
      "progress",
    ],
  );
  assert.deepEqual(results[0]?.observations[0]?.metadata, {
    source: "jsonl",
    rawEventType: "thread.started",
  });
  assert.deepEqual(results[0]?.session, { sessionId: "thread-1" });
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
  assert.match(results.at(-2)?.observations[0]?.message ?? "", /unrecognized JSONL event/);
  assert.deepEqual(results.at(-1)?.observations[0]?.metadata, {
    source: "jsonl",
    rawEventType: "malformed",
  });
});

test("parses partial JSONL chunks incrementally and preserves malformed lines safely", () => {
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
    {
      observations: [
        {
          kind: "progress",
          message: "Codex emitted malformed JSONL: not-json",
          metadata: { source: "jsonl", rawEventType: "malformed" },
        },
      ],
    },
  ]);
  assert.deepEqual(parser.flush(), []);
});
