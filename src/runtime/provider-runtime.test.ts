import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../persistence/database.js";
import { createGoalRepository } from "../persistence/goal-repository.js";
import type { ModelProviderInput } from "./model-provider.js";
import { createProviderRuntime } from "./provider-runtime.js";

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-provider-runtime-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  return { db, goalRepo };
}

test("runtime can use an injected fake provider", async () => {
  const { db, goalRepo } = setup();
  const receivedInputs: ModelProviderInput[] = [];
  const provider = {
    async complete(input: ModelProviderInput) {
      receivedInputs.push(input);
      return {
        text: "Fake provider response",
        metadata: { provider: "fake", model: "fake-model" },
      };
    },
  };
  const runtime = createProviderRuntime({ goalRepo, provider });
  const goal = goalRepo.create({
    title: "Write the smoke test",
    description: "Prove provider injection works",
  });

  const output = await runtime.run(goal.id);

  assert.equal(output.text, "Fake provider response");
  assert.deepEqual(output.metadata, { provider: "fake", model: "fake-model" });
  assert.equal(receivedInputs.length, 1);
  const receivedInput = receivedInputs[0];
  assert.deepEqual(receivedInput?.goal, {
    id: goal.id,
    title: "Write the smoke test",
    description: "Prove provider injection works",
  });
  assert.match(receivedInput?.prompt ?? "", /Write the smoke test/);

  db.close();
});

test("provider runtime throws if goal does not exist", async () => {
  const { db, goalRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    provider: {
      async complete() {
        throw new Error("Provider should not be called");
      },
    },
  });

  await assert.rejects(() => runtime.run("missing-goal"), /Goal not found: missing-goal/);

  db.close();
});
