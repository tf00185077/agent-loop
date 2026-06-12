import express from "express";
import { join } from "node:path";

const app = express();
app.use(express.json());

const dashboardPath = join(process.cwd(), "dashboard");
console.log("Serving dashboard from:", dashboardPath);
app.use(express.static(dashboardPath));

// ── Token store ───────────────────────────────────────────────────────────────
// 優先讀 env var（啟動時帶），也可透過 /api/auth/token 在 dashboard 設定

let token: string =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.COPILOT_GITHUB_TOKEN ||
  "";

const COPILOT = "https://api.githubcopilot.com";
const GITHUB  = "https://api.github.com";

function copilotHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "editor-version": "vscode/1.85.0",
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// GET /api/auth — 確認 token 是否有效，回傳帳號名稱
app.get("/api/auth", async (_req, res) => {
  if (!token) {
    res.json({ loggedIn: false });
    return;
  }
  try {
    const r = await fetch(`${GITHUB}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!r.ok) {
      token = "";
      res.json({ loggedIn: false });
      return;
    }
    const user = (await r.json()) as any;
    res.json({ loggedIn: true, user: user.login });
  } catch {
    res.json({ loggedIn: false });
  }
});

// POST /api/auth/token — 使用者貼上 token，server 驗證後存起來
app.post("/api/auth/token", async (req, res) => {
  const { token: input } = req.body as { token: string };
  if (!input?.trim()) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  try {
    const r = await fetch(`${GITHUB}/user`, {
      headers: {
        Authorization: `Bearer ${input.trim()}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!r.ok) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    const user = (await r.json()) as any;
    token = input.trim();
    res.json({ ok: true, user: user.login });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "validation failed" });
  }
});

// ── Models ────────────────────────────────────────────────────────────────────

// GET /api/models — 列出 Copilot 可用 model
app.get("/api/models", async (_req, res) => {
  if (!token) {
    res.status(401).json({ error: "not logged in" });
    return;
  }
  try {
    const r = await fetch(`${COPILOT}/models`, {
      headers: copilotHeaders(),
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(r.status).json({ error: text });
      return;
    }
    const data = (await r.json()) as any;
    // OpenAI-compatible: { data: [{ id, name, ... }] }
    const models = (data.data ?? []).map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
    }));
    res.json({ models });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "failed to list models" });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────

// POST /api/chat — SSE 串流，OpenAI-compatible
app.post("/api/chat", async (req, res) => {
  const { prompt, model, history = [] } = req.body as {
    prompt: string;
    model: string;
    history?: Array<{ role: string; content: string }>;
  };

  if (!prompt || !model) {
    res.status(400).json({ error: "prompt and model are required" });
    return;
  }
  if (!token) {
    res.status(401).json({ error: "not logged in" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type: string, data: object) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const r = await fetch(`${COPILOT}/chat/completions`, {
      method: "POST",
      headers: copilotHeaders(),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [...history, { role: "user", content: prompt }],
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      send("error", { message: `Copilot API ${r.status}: ${text}` });
      res.end();
      return;
    }

    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            send("delta", { content: delta });
          }
        } catch {}
      }
    }

    send("done", { content: full });
    res.end();
  } catch (e: any) {
    send("error", { message: e?.message ?? "unknown error" });
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  if (token) console.log("Token loaded from environment.");
  else console.log("No token found. Open http://localhost:3000 to set it.");
});
