import { intro, outro, select, spinner, log, note, text, isCancel, cancel } from "@clack/prompts";
import { execSync, spawnSync } from "node:child_process";

/** 是否在 Docker 容器內（無法開瀏覽器） */
const IS_DOCKER = process.env.RUNNING_IN_DOCKER === "true";

/**
 * 確認 gh CLI 是否已安裝
 */
function isGhInstalled(): boolean {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 確認目前 gh 是否已登入
 */
function isGhLoggedIn(): { loggedIn: boolean; user?: string } {
  try {
    const result = execSync("gh auth status 2>&1", { encoding: "utf8" });
    const match = result.match(/Logged in to github\.com account (\S+)/);
    return { loggedIn: true, user: match?.[1] };
  } catch {
    return { loggedIn: false };
  }
}

/**
 * 執行 gh auth login
 * Docker：device flow（不開瀏覽器，終端輸入 code）
 * 本機：瀏覽器 OAuth
 */
function runGhLogin(): boolean {
  const args = IS_DOCKER
    ? ["auth", "login", "--hostname", "github.com", "--git-protocol", "https"]
    : ["auth", "login", "--hostname", "github.com", "--web"];

  const result = spawnSync("gh", args, { stdio: "inherit" });
  return result.status === 0;
}

/**
 * 取得 gh 目前的 token
 */
function getGhToken(): string | null {
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * 驗證手動輸入的 PAT 格式是否合理
 */
function isValidToken(token: string): boolean {
  return /^gh[ops]_[A-Za-z0-9_]{20,}$/.test(token) || /^github_pat_/.test(token);
}

/**
 * 引導式 GitHub 登入流程
 * 成功後設定 process.env.GITHUB_TOKEN，並回傳 token。
 */
export async function guideLogin(): Promise<string> {
  intro(IS_DOCKER ? "GitHub Copilot 登入設定 [Docker 模式]" : "GitHub Copilot 登入設定");

  if (IS_DOCKER) {
    log.info("偵測到 Docker 環境，無法開啟瀏覽器。");
    log.info("將使用 gh device flow（終端輸入驗證碼）或手動輸入 PAT。");
  }

  // ── 步驟 1：確認 gh CLI ──────────────────────────────────────────────────
  if (!isGhInstalled()) {
    log.warn("找不到 gh CLI。");

    if (IS_DOCKER) {
      // 容器內 gh 應已預裝（Dockerfile 有 apk add github-cli）
      log.error("容器內找不到 gh CLI，Dockerfile 可能有問題。改走 PAT 輸入。");
      return await askForPat();
    }

    const install = await select({
      message: "要怎麼繼續？",
      options: [
        { value: "install", label: "顯示安裝指令（我自己裝）" },
        { value: "pat",     label: "跳過，改用手動輸入 GitHub PAT" },
        { value: "abort",   label: "中止" },
      ],
    });

    if (isCancel(install) || install === "abort") {
      cancel("已取消。");
      process.exit(0);
    }

    if (install === "install") {
      note(
        [
          "Ubuntu / Debian:",
          "  sudo apt install gh",
          "",
          "macOS:",
          "  brew install gh",
          "",
          "Windows:",
          "  winget install --id GitHub.cli",
          "",
          "或從官網安裝: https://cli.github.com",
          "",
          "裝完後重新執行此程式。",
        ].join("\n"),
        "安裝 gh CLI"
      );
      process.exit(0);
    }

    return await askForPat();
  }

  // ── 步驟 2：確認是否已登入 ───────────────────────────────────────────────
  const status = isGhLoggedIn();

  if (status.loggedIn && status.user) {
    log.success(`已登入：${status.user}`);

    const action = await select({
      message: "要怎麼做？",
      options: [
        { value: "use",      label: `繼續使用這個帳號 (${status.user})` },
        { value: "relogin",  label: "重新登入其他帳號" },
        { value: "pat",      label: "改用手動輸入 PAT" },
      ],
    });

    if (isCancel(action)) { cancel("已取消。"); process.exit(0); }
    if (action === "use")  return await finalizeGhToken();
    if (action === "pat")  return await askForPat();
    // relogin → 繼續往下
  } else {
    log.info("尚未登入 GitHub。");
  }

  // ── 步驟 3：選擇登入方式 ─────────────────────────────────────────────────
  const dockerOptions = [
    { value: "device", label: "gh device flow（終端輸入驗證碼，推薦）" },
    { value: "pat",    label: "手動輸入 GitHub PAT" },
  ];
  const localOptions = [
    { value: "web",    label: "瀏覽器 OAuth 登入（推薦）" },
    { value: "device", label: "gh device flow（終端輸入驗證碼）" },
    { value: "pat",    label: "手動輸入 GitHub PAT" },
  ];

  const method = await select({
    message: "選擇登入方式",
    options: IS_DOCKER ? dockerOptions : localOptions,
  });

  if (isCancel(method)) { cancel("已取消。"); process.exit(0); }
  if (method === "pat")  return await askForPat();

  // ── 步驟 4：執行 gh auth login ───────────────────────────────────────────
  if (IS_DOCKER) {
    note(
      [
        "gh 會顯示一組 8 位驗證碼（例如 XXXX-XXXX）。",
        "請開啟瀏覽器前往：  https://github.com/login/device",
        "貼上驗證碼後授權即完成。",
      ].join("\n"),
      "Device Flow 說明"
    );
  } else {
    log.info("即將開啟瀏覽器進行 GitHub OAuth 登入...");
  }

  const ok = runGhLogin();

  if (!ok) {
    log.error("gh auth login 失敗。");
    const fallback = await select({
      message: "要改用 PAT 嗎？",
      options: [
        { value: "yes", label: "是，手動輸入 PAT" },
        { value: "no",  label: "否，中止" },
      ],
    });
    if (isCancel(fallback) || fallback === "no") {
      cancel("已取消。");
      process.exit(1);
    }
    return await askForPat();
  }

  return await finalizeGhToken();
}

// ── 內部 helpers ─────────────────────────────────────────────────────────────

async function finalizeGhToken(): Promise<string> {
  const s = spinner();
  s.start("取得 token 中...");

  const token = getGhToken();

  if (!token) {
    s.stop("無法取得 token。");
    log.error("請確認 Copilot subscription 是否有效。");
    process.exit(1);
  }

  s.stop("Token 取得成功。");
  process.env.GITHUB_TOKEN = token;

  const statusAfter = isGhLoggedIn();
  note(
    [
      `帳號：${statusAfter.user ?? "unknown"}`,
      `Token：${token.slice(0, 8)}${"*".repeat(10)}`,
      "",
      "已寫入 process.env.GITHUB_TOKEN，本次執行有效。",
      IS_DOCKER
        ? "容器重啟後 gh 登入狀態透過 named volume (gh-config) 保留。"
        : "若想永久保留，加到 ~/.bashrc：\n  export GITHUB_TOKEN=$(gh auth token)",
    ].join("\n"),
    "登入完成"
  );

  outro("準備好了，繼續執行...");
  return token;
}

async function askForPat(): Promise<string> {
  log.info("到 https://github.com/settings/tokens 產生 classic token，勾選 read:user scope。");

  const token = await text({
    message: "貼上你的 GitHub PAT：",
    placeholder: "ghp_... 或 github_pat_...",
    validate(val) {
      if (!val || !val.trim()) return "不能為空";
      if (!isValidToken(val.trim()))
        return "格式不符，應以 ghp_ / gho_ / ghs_ / github_pat_ 開頭";
    },
  });

  if (isCancel(token)) { cancel("已取消。"); process.exit(0); }

  const t = (token as string).trim();
  process.env.GITHUB_TOKEN = t;
  const masked = t.slice(0, 8) + "*".repeat(10);
  const persistHint = IS_DOCKER
    ? "若要不每次重輸入，在 .env 加入 GITHUB_TOKEN=<your-token>"
    : "若要不每次重輸入，加到 ~/.bashrc：\n  export GITHUB_TOKEN=$(gh auth token)";
  note(
    ["Token：" + masked, "", "已寫入 process.env.GITHUB_TOKEN，本次執行有效。", persistHint].join("\n"),
    "設定完成"
  );

  outro("準備好了，繼續執行...");
  return t;
}

// ── CLI 入口（npm run login 時直接執行）──────────────────────────────────────
const isMain =
  process.argv[1]?.endsWith("login.ts") ||
  process.argv[1]?.endsWith("login.js");

if (isMain) {
  await guideLogin();
}
