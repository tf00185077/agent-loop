import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeProcessOutput } from "./process-output-sanitizer.js";

test("redacts Authorization headers", () => {
  const result = sanitizeProcessOutput("Authorization: Bearer abc123.def456");
  assert.equal(result.includes("abc123"), false);
  assert.match(result, /\[redacted\]/);
});

test("redacts bare bearer tokens", () => {
  const result = sanitizeProcessOutput("sending request with bearer sometoken1234");
  assert.equal(result.includes("sometoken1234"), false);
});

test("redacts OpenAI-style API key prefixes", () => {
  const result = sanitizeProcessOutput("using key sk-abcdefghijklmnopqrstuvwxyz");
  assert.equal(result.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
});

test("redacts api-key style command flags", () => {
  const result = sanitizeProcessOutput("codex --api-key supersecretvalue exec");
  assert.equal(result.includes("supersecretvalue"), false);
});

test("redacts cookie headers", () => {
  const result = sanitizeProcessOutput("Cookie: session=abcd1234");
  assert.equal(result.includes("abcd1234"), false);
});

test("leaves ordinary progress text untouched", () => {
  const text = "Analyzing the goal and drafting a plan...";
  assert.equal(sanitizeProcessOutput(text), text);
});
