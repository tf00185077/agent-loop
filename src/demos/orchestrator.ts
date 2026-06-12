import { AgentSpawner } from "../AgentSpawner.js";
import type { AgentDefinition } from "../AgentSpawner.js";

/**
 * Demo: orchestrator pattern — multiple agents, let the runtime auto-infer
 * which one to delegate to based on the user prompt.
 *
 * Agents defined:
 *  - researcher  (read-only, infer:true)
 *  - editor      (write, infer:true)
 *  - reviewer    (security review, infer:true, requires explicit keywords)
 *
 * Run: npm run demo:orchestrator "Add a hello world function to src/index.ts"
 */

const agents: AgentDefinition[] = [
  {
    name: "researcher",
    displayName: "Research Agent",
    description:
      "Explores codebases and answers questions. Best for analysis, summarization, and read-only tasks.",
    tools: ["grep", "glob", "view"],
    prompt:
      "You are a meticulous research assistant. Analyze code and answer questions. Do not modify any files.",
    infer: true,
  },
  {
    name: "editor",
    displayName: "Editor Agent",
    description:
      "Makes targeted code changes — creating, modifying, or deleting files. Use for any write operation.",
    tools: ["view", "edit", "bash"],
    prompt:
      "You are a precise code editor. Make only the minimal changes needed. Preserve style and formatting. Explain every change briefly.",
    infer: true,
  },
  {
    name: "reviewer",
    displayName: "Security Reviewer",
    description:
      "Performs security-focused code review. Use when the user asks to audit, review for vulnerabilities, or check OWASP compliance.",
    tools: ["grep", "glob", "view"],
    prompt:
      "You are a security-focused code reviewer specializing in OWASP Top 10. Identify vulnerabilities, rate severity, and suggest fixes. Never modify files.",
    infer: true,
  },
];

console.log("Starting orchestrator demo...");
console.log("Registered agents:", agents.map((a) => a.name).join(", "));
console.log(
  "Prompt:",
  process.argv[2] ?? "(default — researcher will handle it)"
);
console.log("");

const spawner = new AgentSpawner(agents);

const result = await spawner.spawn({
  model: "claude-sonnet-4.6",
  // No defaultAgent — let runtime infer from prompt
  prompt:
    process.argv[2] ??
    "Summarize the structure of this project and suggest one improvement.",
});

console.log("\n--- Final Response ---");
console.log(result.response);

if (result.events.length > 0) {
  console.log("\n--- Sub-Agent Lifecycle Events ---");
  result.events.forEach((e) => console.log(e));
}
