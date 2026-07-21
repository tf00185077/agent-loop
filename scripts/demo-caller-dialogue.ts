/**
 * Observable demo of the caller-confirmation-dialogue round.
 *
 * Runs the REAL backend (createApp + SQLite) over HTTP, with only the provider
 * adapter scripted so the round is deterministic and needs no CLI login. It
 * drives a `required`-policy goal through the full flow and narrates each phase
 * the way you'd see it in the dashboard: goal status, the durable input-request
 * thread, and the event timeline.
 *
 *   node --import tsx scripts/demo-caller-dialogue.ts
 *
 * Pass --hold to stop after the plan proposal so you can reply yourself with
 * curl or the dashboard (it prints the exact commands) instead of auto-driving.
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

const HOLD = process.argv.includes("--hold");
const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-demo-")), "demo.sqlite");

// ── a deterministic supervisor that plays the confirmation dialogue ──────────
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
      if (turn === 1) {
        // Under `required` the supervisor must confirm before work: it tries to
        // dispatch (rejected), then proposes its plan for the caller.
        events.push(block(input, { type: "managed_delegation.request", role: "worker", taskId: "task-1", summary: "start", prompt: "x" }));
        events.push(block(input, { type: "managed_goal.propose_plan", summary: "Plan: ingest the data, then generate the weekly report.", items: ["Ingest", "Report"] }));
      } else if (conversing) {
        const replies = (input.prompt.match(/Caller:/g) ?? []).length;
        if (replies < 2) {
          events.push(block(input, { type: "managed_goal.request_input", question: "Should reports be weekly or daily?" }));
        } else {
          events.push(block(input, { type: "managed_goal.ready_to_proceed", summary: "Understood — proceeding." }));
        }
      } else if (resumed) {
        events.push(block(input, { type: "managed_delegation.request", role: "worker", taskId: "task-1", summary: "Ingest the data", prompt: "Full instructions for the worker." }));
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

// ── tiny HTTP helpers ────────────────────────────────────────────────────────
async function get(url: string) { const r = await fetch(url); return { status: r.status, body: r.status === 404 ? null : (await r.json()) as any }; }
async function post(url: string, body?: unknown) {
  const r = await fetch(url, { method: "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i += 1) { if (await fn()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${label}`);
}

function hr(title: string) { console.log(`\n${"─".repeat(70)}\n${title}\n${"─".repeat(70)}`); }
async function showState(url: string, goalId: string) {
  const goal = (await get(`${url}/api/goals/${goalId}`)).body;
  console.log(`  goal.status = ${goal.status}   (confirmationPolicy=${goal.confirmationPolicy})`);
  const req = (await get(`${url}/api/goals/${goalId}/input-request`)).body;
  if (req) {
    console.log(`  pending input request: ${req.reasonCode}  phase=${req.payload.phase ?? "-"}  decisions=[${req.payload.allowedDecisions.join(", ")}]`);
    for (const m of req.payload.thread ?? []) console.log(`      ${m.role === "caller" ? "You       " : "Supervisor"} │ ${m.text}`);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
const db = openDatabase({ path: dbPath });
createProviderSettingsRepository(db).save({ provider: "codex-local", modelLabel: "gpt-5-codex", codexCommandPath: "C:\\fake\\codex.exe", status: { ...defaultProviderStatus } });
const app = createApp(db, { agentRuntimeAdapters: { "codex-local": scriptedSupervisor() } });
const server = createServer(app);
const url: string = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));

hr("1. Create a REQUIRED-policy goal and start it");
const goalId = (await post(`${url}/api/goals`, { title: "Weekly data report", description: "Ingest data and produce a weekly report.", confirmationPolicy: "required" })).body.id as string;
console.log(`  created goal ${goalId}`);
await post(`${url}/api/goals/${goalId}/start`);
await waitFor(async () => (await get(`${url}/api/goals/${goalId}`)).body.status === "waiting_user", "waiting_user");

hr("2. Supervisor tried to work, was told to confirm first, and proposed a plan");
console.log("  The confirm-before-work checkpoint rejected the premature delegation:");
const firstReject = ((await get(`${url}/api/goals/${goalId}/events`)).body as any[]).find((e) => e.data.runtimeEventType === "delegation.rejected");
console.log(`    ✗ ${firstReject.data.safeReason}`);
await showState(url, goalId);

if (HOLD) {
  hr("HOLD — reply yourself and watch the goal resume");
  const reqId = (await get(`${url}/api/goals/${goalId}/input-request`)).body.id;
  console.log("  The backend is running at:", url);
  console.log("  Reply in the conversation:");
  console.log(`    curl -s -X POST ${url}/api/goals/${goalId}/input-request/${reqId}/respond -H "Content-Type: application/json" -d '{"decision":"provide_guidance","guidance":"Weekly is fine."}'`);
  console.log("  Or force it forward / abandon:");
  console.log(`    ...-d '{"decision":"proceed"}'      ...-d '{"decision":"abandon"}'`);
  console.log("  Watch status + thread:");
  console.log(`    curl -s ${url}/api/goals/${goalId}/input-request | jq`);
  console.log("\n  (Ctrl+C to stop. Leaving the server up.)");
  return;
}

hr("3. You reply — a READ-ONLY conversational turn runs (work stays blocked)");
console.log("  POST respond {decision: provide_guidance, guidance: 'Reports matter most.'}");
await post(`${url}/api/goals/${goalId}/input-request/${(await get(`${url}/api/goals/${goalId}/input-request`)).body.id}/respond`, { decision: "provide_guidance", guidance: "Reports matter most." });
await showState(url, goalId);
console.log("  → the supervisor asked a follow-up; the goal is still waiting on you.");

hr("4. You reply again — the supervisor signals ready and work is dispatched");
console.log("  POST respond {decision: provide_guidance, guidance: 'Weekly is fine.'}");
const r2 = await post(`${url}/api/goals/${goalId}/input-request/${(await get(`${url}/api/goals/${goalId}/input-request`)).body.id}/respond`, { decision: "provide_guidance", guidance: "Weekly is fine." });
console.log(`  respond → ${JSON.stringify(r2.body?.outcome)}   (conversation resolved, goal resumed)`);
// The payoff: only now — after confirmation — is the worker delegation accepted.
const timelineUpToDispatch: string[] = [];
await waitFor(async () => {
  const events = (await get(`${url}/api/goals/${goalId}/events`)).body as any[];
  timelineUpToDispatch.length = 0;
  for (const e of events) {
    const t = e.data.runtimeEventType as string | undefined;
    if (t) timelineUpToDispatch.push(t);
    if (t === "delegation.accepted") return true;
  }
  return false;
}, "worker dispatched");
console.log("  ✓ worker delegation ACCEPTED — the confirmation gate is now satisfied.");

hr("5. Event timeline for the round (what the dashboard renders)");
const upto = timelineUpToDispatch.slice(0, timelineUpToDispatch.indexOf("delegation.accepted") + 1);
const eventsForNotes = (await get(`${url}/api/goals/${goalId}/events`)).body as any[];
for (const t of upto) {
  if (!/plan_proposed|caller_replied|turn_started|supervisor_replied|plan_confirmed|conversation\.(resolved|resumed)|delegation\.(rejected|accepted)|supervisor\.question/.test(t)) continue;
  const rej = t === "delegation.rejected" ? eventsForNotes.find((e) => e.data.runtimeEventType === "delegation.rejected") : null;
  const note = rej ? `  ← ${String(rej.data.safeReason).slice(0, 44)}…` : "";
  console.log(`  • ${t}${note}`);
}

console.log("\n✅ One round: work was GATED on caller confirmation, resolved through a multi-turn");
console.log("   READ-ONLY conversation, and only then was the worker dispatched.");
console.log("   (The scripted worker does no real work, so the goal then idles — the point");
console.log("    is the confirmation dialogue, not a finished report.)\n");

await new Promise<void>((res) => server.close(() => res()));
db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
