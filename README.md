# auto-agent

讓 AI agent 自主推進軟體專案。使用者設定目標，agent 自己拆解、執行、驗證，不斷 loop 直到完成。

---

## Goal

使用者透過 Dashboard 輸入目標，Agent 負責：
- 把目標拆解成可執行的子任務
- 依任務性質派給對應的 sub-agent（研究 / 寫 code / 驗證）
- 執行後驗證結果，失敗則自動修正重試
- 每次推進產生 git commit，保留完整歷史
- 關鍵決策點暫停，等使用者確認後繼續

---

## Architecture

```
┌─────────────────────────────────────────┐
│  Dashboard (Next.js / React)            │
│  - 輸入專案目標                          │
│  - 即時看 agent loop 進度               │
│  - 顯示 commit / 測試結果 / 錯誤        │
│  - 在關鍵決策點核准或修正方向           │
└──────────────────┬──────────────────────┘
                   │ WebSocket（即時推送 loop 狀態）
┌──────────────────▼──────────────────────┐
│  Agent Runtime (Node.js in Docker)      │
│  - AgentSpawner  → 派給對應 sub-agent   │
│  - LoopController → 目標拆解/執行/驗證  │
│  Sub-agents:                            │
│    researcher  → 讀 code、分析、規劃    │
│    editor      → 寫 code、修改檔案      │
│    reviewer    → 驗證結果、跑測試       │
└──────────────────┬──────────────────────┘
                   │ Volume mount
┌──────────────────▼──────────────────────┐
│  Workspace                              │
│  - agent 讀寫的實際專案檔案             │
│  - git 版控，每個 loop 產生 commit      │
└─────────────────────────────────────────┘
```

---

## Project Structure

```
auto-agent/
  src/
    AgentSpawner.ts        # spawn / 管理 sub-agents
    login.ts               # 引導式 GitHub 登入（支援 Docker device flow）
    index.ts               # 入口
    loop/
      LoopController.ts    # 目標拆解、loop 推進、狀態管理   (planned)
      GoalPlanner.ts       # 把使用者目標拆成可執行子任務    (planned)
      TaskVerifier.ts      # 驗證每次 loop 的結果           (planned)
    ws/
      server.ts            # WebSocket server               (planned)
    demos/
      researcher.ts
      orchestrator.ts
  dashboard/               # React / Next.js frontend       (planned)
  Dockerfile
  docker-compose.yml
  .env.example
```

---

## Quick Start

### 前置需求

- Node.js >= 20.19.0（本機啟動用）
- Docker + Docker Compose（容器啟動用）
- GitHub Copilot subscription

### 本機啟動

```bash
# 安裝相依套件
npm install

# 引導式登入（第一次執行）
npm run login

# 執行主程式
npm run dev "你的 prompt"

# 其他 demo
npm run demo:researcher "問題"
npm run demo:orchestrator "任務描述"

# 編譯
npm run build
npm start "你的 prompt"
```

### Docker 啟動

```bash
# 第一次：走 device flow 登入
# gh 會印出驗證碼，前往 github.com/login/device 輸入
docker compose run --rm login

# 執行 agent
docker compose run --rm auto-agent "你的 prompt"
```

### 環境變數（選填）

有 token 的話可以跳過引導式登入，直接執行：

```bash
cp .env.example .env
# 編輯 .env，填入 GITHUB_TOKEN
```

```bash
# 三擇一即可
GITHUB_TOKEN=***GH_TOKEN=***COPILOT_GITHUB_TOKEN=***```

---

## Cross-Platform Strategy

Agent runtime 永遠跑在 Docker（Linux）容器內，跨平台差異在架構層解決：

| 問題 | 解法 |
|---|---|
| SDK native binary 衝突 | Docker 統一 Linux binary |
| Windows 沒有 bash | Agent 在容器內跑，永遠是 Linux bash |
| 路徑格式不一致 | 容器內統一 Linux 路徑 |
| CRLF / LF | `.gitattributes` 強制 LF |
| Dashboard 跨平台 | 純 web，瀏覽器跑，免費跨平台 |

---

## Status

- [x] AgentSpawner
- [x] 引導式登入（gh OAuth / device flow / PAT）
- [x] Docker（multi-stage build，named volume 保留登入狀態）
- [ ] LoopController
- [ ] GoalPlanner
- [ ] TaskVerifier
- [ ] WebSocket server
- [ ] Dashboard
