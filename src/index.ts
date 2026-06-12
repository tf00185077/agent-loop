import { AgentSpawner } from "./AgentSpawner.js";
import type { AgentDefinition } from "./AgentSpawner.js";
import { guideLogin } from "./login.js";

/**
 * Entry point — 先走引導式登入，再用 researcher + editor 雙 agent 執行 prompt。
 * Run: npm run dev "你的 prompt"
 */

// 如果還沒設 GITHUB_TOKEN，先跑引導式登入
if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && !process.env.COPILOT_GITHUB_TOKEN) {
  await guideLogin();
}

const agents: AgentDefinition[] = [
  {
    name: "researcher",
    displayName: "Research Agent",
    description:
      "Explores codebases, reads files, and answers questions. Use this for any question-answering, summarization, or analysis task.",
    tools: ["grep", "glob", "view"],
    prompt:
      "You are a meticulous research assistant. Analyze the provided code or context carefully, then give a clear, concise answer. Never modify files.",
    infer: true,
  },
  {
    name: "editor",
    displayName: "Editor Agent",
    description:
      "Makes targeted, surgical code changes. Use this when the user wants to create, modify, or delete files.",
    tools: ["view", "edit", "bash"],
    prompt:
      "You are a precise code editor. Make only the minimal changes required to fulfill the request. Preserve existing style and formatting. Explain each change you make.",
    infer: true,
  },
];

const spawner = new AgentSpawner(agents);

const result = await spawner.spawn({
  model: "claude-sonnet-4.6",
  prompt: process.argv[2] ?? "Explain what this project does in one paragraph.",
});

console.log("\n--- Final Response ---");
console.log(result.response);
console.log("\n--- Session ID ---");
console.log(result.sessionId);
if (result.events.length > 0) {
  console.log("\n--- Sub-Agent Events ---");
  result.events.forEach((e) => console.log(e));
}
