import { AgentSpawner } from "../AgentSpawner.js";
import type { AgentDefinition } from "../AgentSpawner.js";

/**
 * Demo: single researcher agent
 * Pre-selects the researcher agent at session creation,
 * so the runtime doesn't need to infer which agent to use.
 *
 * Run: npm run demo:researcher
 */

const agents: AgentDefinition[] = [
  {
    name: "researcher",
    displayName: "Research Agent",
    description: "Answers questions, reads files, summarizes code.",
    tools: ["grep", "glob", "view"],
    prompt:
      "You are a research assistant. Read the relevant code and answer questions accurately. Never modify files.",
    infer: false, // only invoked when explicitly selected
  },
];

const spawner = new AgentSpawner(agents);

const result = await spawner.spawn({
  model: "claude-sonnet-4.6",
  defaultAgent: "researcher", // pre-select at session creation
  prompt:
    process.argv[2] ??
    "List the main TypeScript source files in the current directory and describe each one briefly.",
});

console.log("\n--- Researcher Response ---");
console.log(result.response);
