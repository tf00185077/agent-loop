/**
 * Dashboard demo server for the caller-confirmation-dialogue UI.
 *
 * Runs the REAL backend (createApp + a temp SQLite) on port 3001 — the port the
 * dashboard's Vite dev server proxies /api to — but injects a deterministic
 * scripted supervisor so you get a reliable conversation to click through
 * without a logged-in provider. It seeds one `required`-policy goal that is
 * already parked in a plan-confirmation conversation, so the thread panel is
 * ready the moment you open the goal.
 *
 *   Terminal A:  node --import tsx scripts/demo-server.ts
 *   Terminal B:  npm run dev:web
 *   Browser:     open the Vite URL it prints (http://localhost:5173)
 *
 * In the dashboard: open the "waiting_user" goal, inspect the thread panel,
 * type a reply (the supervisor asks a follow-up), reply again (it signals ready
 * and the goal resumes), or use Proceed now / Abandon goal.
 */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/backend/app.js";
import { openDatabase } from "../src/persistence/database.js";
import { createProviderSettingsRepository } from "../src/persistence/provider-settings-repository.js";
import { defaultProviderStatus } from "../src/domain/index.js";
import type { AgentRuntimeAdapter, AgentRuntimeEvent } from "../src/domain/index.js";

const PORT = Number(process.env.PORT ?? 3001);
const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-demo-server-")), "demo.sqlite");

function scriptedSupervisor(): AgentRuntimeAdapter {
  let turn = 0;
  const block = (i: { sessionId: string; goalId: string; runId: string }, b: Record<string, unknown>): AgentRuntimeEvent => ({
    type: "progress", sessionId: i.sessionId, goalId: i.goalId, runId: i.runId,
    message: "control", occurredAt: new Date().toISOString(), metadata: { delegationControlEvent: b },
  });
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      turn += 1;
      const events: AgentRuntimeEvent[] = [];
      const conversing = /READ-ONLY clarification/.test(input.prompt);
      const resumed = /conversation resolved/i.test(input.prompt);
      if (input.parent?.sessionId) {
        // Child (worker) sessions are not exercised by this demo.
      } else if (turn === 1) {
        events.push(block(input, { type: "managed_delegation.request", role: "worker", taskId: "task-1", summary: "start", prompt: "x" }));
        events.push(block(input, { type: "managed_goal.propose_plan", summary: "Plan: ingest the data, then generate the weekly report.", items: ["Ingest the data", "Generate the report"] }));
      } else if (conversing) {
        const replies = (input.prompt.match(/Caller:/g) ?? []).length;
        events.push(replies < 2
          ? block(input, { type: "managed_goal.request_input", question: "Should the report run weekly or daily?" })
          : block(input, { type: "managed_goal.ready_to_proceed", summary: "Understood — proceeding." }));
      } else if (resumed) {
        // A flat goal completes cleanly once confirmed (no real worker to run).
        events.push(block(input, { type: "managed_delegation.complete", summary: "Weekly report delivered." }));
      }
      events.push({ type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId, message: "end", occurredAt: new Date().toISOString() });
      return {
        sessionId: input.sessionId,
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
        async *events() { for (const e of events) yield e; },
        async send() {}, async approve() {}, async reject() {}, async cancel() {},
      };
    },
  };
}

const db = openDatabase({ path: dbPath });
createProviderSettingsRepository(db).save({
  provider: "codex-local", modelLabel: "gpt-5-codex", codexCommandPath: "C:\\fake\\codex.exe", status: { ...defaultProviderStatus },
});
const app = createApp(db, { agentRuntimeAdapters: { "codex-local": scriptedSupervisor() } });
const server = createServer(app);

server.listen(PORT, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${PORT}`;
  const post = async (path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json() as any;
  };
  const created = await post("/api/goals", {
    title: "Weekly data report",
    description: "Ingest data and produce a weekly report for the ops team.",
    confirmationPolicy: "required",
  });
  await post(`/api/goals/${created.id}/start`);

  // Wait until the supervisor has proposed its plan and parked in waiting_user.
  for (let i = 0; i < 100; i += 1) {
    const goal = await (await fetch(`${base}/api/goals/${created.id}`)).json() as any;
    if (goal.status === "waiting_user") break;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\n  Demo backend listening on ${base}  (scripted supervisor, temp DB)`);
  console.log(`  Seeded a REQUIRED-policy goal already in a plan-confirmation conversation:`);
  console.log(`    "${created.title}"  →  status waiting_user`);
  console.log(`\n  Now start the dashboard in another terminal:`);
  console.log(`    npm run dev:web`);
  console.log(`  then open the Vite URL it prints and click into the goal.`);
  console.log(`  Reply in the thread panel → the supervisor asks a follow-up → reply again →`);
  console.log(`  it signals ready and the goal resumes and completes. Proceed / Abandon also work.\n`);
});
