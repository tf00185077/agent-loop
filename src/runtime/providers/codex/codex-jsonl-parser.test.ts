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

test("parses current Codex command_execution item payloads", () => {
  const parser = createCodexJsonlParser();

  const results = parser.push(
    [
      JSON.stringify({
        type: "item.started",
        item: { id: "cmd-1", type: "command_execution", command: "npm test" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          exit_code: 0,
          aggregated_output: "tests passed",
        },
      }),
      JSON.stringify({
        type: "item.failed",
        item: {
          id: "cmd-2",
          type: "command_execution",
          command: "npm run build",
          exit_code: 1,
          stderr: "compile failed",
        },
      }),
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    results.flatMap((result) => result.observations.map((observation) => observation.kind)),
    ["command.started", "command.completed", "command.failed"],
  );
  assert.deepEqual(results[0]?.observations[0]?.command, {
    label: "npm test",
    status: "started",
  });
  assert.deepEqual(results[1]?.observations[0]?.command, {
    label: "npm test",
    status: "completed",
    exitCode: 0,
    stdoutTail: "tests passed",
  });
  assert.deepEqual(results[2]?.observations[0]?.command, {
    label: "npm run build",
    status: "failed",
    exitCode: 1,
    stderrTail: "compile failed",
  });
});

test("extracts final text from nested Codex agent_message items", () => {
  const parser = createCodexJsonlParser();

  const results = parser.push(
    [
      JSON.stringify({
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Nested final answer" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "msg-2", type: "agent_message", message: "Newer final answer" },
      }),
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    results.flatMap((result) => result.observations.map((observation) => observation.message)),
    ["Nested final answer", "Newer final answer"],
  );
  assert.deepEqual(
    results.map((result) => result.finalMessage),
    ["Nested final answer", "Newer final answer"],
  );
});

test("does not emit visible unrecognized progress for unknown Codex item payloads", () => {
  const parser = createCodexJsonlParser();

  const results = parser.push(
    [
      JSON.stringify({
        type: "item.started",
        item: { id: "future-1", type: "future_item", label: "future work" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "future-1", type: "future_item", status: "done" },
      }),
      JSON.stringify({ type: "future.top_level", payload: { still: "diagnostic" } }),
      "",
    ].join("\n"),
  );

  assert.equal(results.length, 1);
  assert.match(results[0]?.observations[0]?.message ?? "", /unrecognized JSONL event/);
  assert.deepEqual(results[0]?.observations[0]?.metadata, {
    source: "jsonl",
    rawEventType: "future.top_level",
  });
});

test("maps known non-command Codex item payloads to compact observations when useful", () => {
  const parser = createCodexJsonlParser();

  const results = parser.push(
    [
      JSON.stringify({
        type: "item.completed",
        item: { id: "reasoning-1", type: "reasoning", text: "checking files" },
      }),
      JSON.stringify({
        type: "item.started",
        item: { id: "tool-1", type: "tool_use", name: "read_file" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "tool-1", type: "tool_use", name: "read_file", output: "loaded README.md" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "tool-result-1", type: "tool_result", content: "done" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "file-1", type: "file_change", path: "src/index.ts" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "error-1", type: "error", message: "tool exploded" },
      }),
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    results.flatMap((result) => result.observations.map((observation) => observation.kind)),
    ["progress", "progress", "progress", "progress", "progress", "command.failed"],
  );
  assert.deepEqual(
    results.flatMap((result) => result.observations.map((observation) => observation.message)),
    [
      "reasoning: checking files",
      "tool started: read_file",
      "tool completed: read_file: loaded README.md",
      "tool result: done",
      "file change: src/index.ts",
      "tool exploded",
    ],
  );
  assert.equal(results.at(-1)?.errorMessage, "tool exploded");
});
