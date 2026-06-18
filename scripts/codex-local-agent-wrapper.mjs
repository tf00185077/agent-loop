import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codexCommandPath = process.env.AUTO_AGENT_CODEX_COMMAND_PATH?.trim();
const modelLabel = process.env.AUTO_AGENT_OPENAI_LOCAL_MODEL?.trim();
const defaultModelLabels = new Set(["gpt-5-codex-subscription", "mock-v1"]);

try {
  const input = await readJsonFromStdin();
  const prompt = buildPrompt(input);
  const text = await runCodexExec(prompt);
  process.stdout.write(`${JSON.stringify({ text })}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

async function readJsonFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("Codex Local wrapper input is required");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Codex Local wrapper input must be JSON");
  }
}

function buildPrompt(input) {
  if (!isRecord(input) || typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new Error("Codex Local wrapper input must include a non-empty prompt");
  }

  return input.prompt;
}

async function runCodexExec(prompt) {
  if (!codexCommandPath) {
    throw new Error("AUTO_AGENT_CODEX_COMMAND_PATH is required");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "auto-agent-codex-wrapper-"));
  const outputPath = join(tempDir, "last-message.txt");
  const args = [
    ...readExtraArgs(),
    "exec",
    "--skip-git-repo-check",
    "--output-last-message",
    outputPath,
  ];

  if (modelLabel && !defaultModelLabels.has(modelLabel)) {
    args.push("--model", modelLabel);
  }

  args.push("-");

  try {
    const { code, stderr } = await runCommand(codexCommandPath, args, prompt);
    if (code !== 0) {
      throw new Error(`Codex CLI exited with code ${code}: ${stderr.trim() || "no stderr"}`);
    }

    const text = (await readFile(outputPath, "utf8")).trim();
    if (!text) throw new Error("Codex CLI returned an empty response");
    return text;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function readExtraArgs() {
  const raw = process.env.AUTO_AGENT_CODEX_COMMAND_ARGS_JSON?.trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AUTO_AGENT_CODEX_COMMAND_ARGS_JSON must be a JSON array of strings");
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("AUTO_AGENT_CODEX_COMMAND_ARGS_JSON must be a JSON array of strings");
  }

  return parsed;
}

function runCommand(command, args, stdin) {
  return new Promise((resolve, reject) => {
    const spawnRequest = toSpawnRequest(command, args);
    const child = spawn(spawnRequest.command, spawnRequest.args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
    child.stdin.end(stdin);
  });
}

function toSpawnRequest(command, args) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/c", command, ...args],
    };
  }

  return { command, args };
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
