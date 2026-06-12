import express from "express";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { AgentSpawner } from "../AgentSpawner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Serve dashboard static files
app.use(express.static(join(__dirname, "../../dashboard")));

// ── Auth ─────────────────────────────────────────────────────────────────────

/** 確認 gh 是否已登入，回傳帳號名稱 */
function getGhUser(): string | null {
  try {
    const out = execSync("gh auth status 2>&1", { encoding: "utf8" });
    const match = out.match(/Logged in to github\.com account (\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 取得 gh token */
function getGhToken(): string | null {
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// GET /api/auth — 確認登入狀態
app.get("/api/auth", (_req, res) => {
  const user = getGhUser();
  if (!user) {
    res.json({ loggedIn: false });
    return;
  }
  const token = getGhToken();
  if (token) process.env.GITHUB_TOKEN = token;
  res.json({ loggedIn: true, user });
});

// ── Models ───────────────────────────────────────────────────────────────────

// GET /api/models — 列出可用 model
app.get("/api/models", async (_req, res) => {
  const token = getGhToken();
  if (!token) {
    res.status(401).json({ error: "not logged in" });
    return;
  }
  process.env.GITHUB_TOKEN = token;

  try {
    const client = new CopilotClient();
    await client.start();
    const models = await client.listModels();
    await client.stop();
    res.json({ models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "failed to list models" });
  }
});

// ── Chat ─────────────────────────────────────────────────────────────────────

// POST /api/chat — 送出 prompt，SSE 串流回應
app.post("/api/chat", async (req, res) => {
  const { prompt, model } = req.body as { prompt: string; model: string };

  if (!prompt || !model) {
    res.status(400).json({ error: "prompt and model are required" });
    return;
  }

  const token = getGhToken();
  if (!token) {
    res.status(401).json({ error: "not logged in" });
    return;
  }
  process.env.GITHUB_TOKEN = token;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type: string, data: object) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    const spawner = new AgentSpawner([
      {
        name: "researcher",
        displayName: "Research Agent",
        description: "Answers questions, reads files, summarizes code.",
        tools: ["grep", "glob", "view"],
        prompt: "You are a research assistant. Analyze code and answer questions. Do not modify files.",
        infer: true,
      },
      {
        name: "editor",
        displayName: "Editor Agent",
        description: "Makes targeted code changes.",
        tools: ["view", "edit", "bash"],
        prompt: "You are a code editor. Make minimal, surgical changes. Explain each change.",
        infer: true,
      },
    ]);

    // 直接用底層 client 讓 delta 可以串流
    const client = new CopilotClient();
    await client.start();

    const session = await client.createSession({
      model,
      customAgents: [
        {
          name: "researcher",
          displayName: "Research Agent",
          description: "Answers questions, reads files, summarizes code.",
          tools: ["grep", "glob", "view"],
          prompt: "You are a research assistant. Analyze code and answer questions. Do not modify files.",
          infer: true,
        },
        {
          name: "editor",
          displayName: "Editor Agent",
          description: "Makes targeted code changes.",
          tools: ["view", "edit", "bash"],
          prompt: "You are a code editor. Make minimal, surgical changes. Explain each change.",
          infer: true,
        },
      ],
      onPermissionRequest: approveAll,
    });

    session.on("subagent.selected", (e: any) => {
      send("subagent", { agentName: e.data?.agentName ?? "unknown" });
    });

    session.on("assistant.message_delta", (e: any) => {
      const delta = e.data?.deltaContent ?? "";
      if (delta) send("delta", { content: delta });
    });

    const idle = new Promise<void>((resolve) => {
      session.on("session.idle", () => resolve());
    });

    await session.send({ prompt });
    await idle;

    const allEvents = await session.getEvents();
    const last = [...allEvents].reverse().find((e: any) => e.type === "assistant.message");
    const full = (last as any)?.data?.content ?? "";

    send("done", { content: full });
    res.end();

    await session.disconnect();
    await client.stop();
  } catch (e: any) {
    send("error", { message: e?.message ?? "unknown error" });
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
