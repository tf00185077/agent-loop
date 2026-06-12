# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# npm ci 在 alpine (musl) 上會裝 copilot-linuxmusl-x64 binary
# 包含 devDependencies（tsx 等開發工具）
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# gh CLI — 讓容器內能走 gh device flow 登入
RUN apk add --no-cache github-cli

# 複製 build 產物、node_modules（含 tsx、copilot binary 等所有工具）
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json   ./
COPY tsconfig.json  ./

# src 和 dashboard 在 docker-compose 開發模式下由 volume 掛入
# 這裡複製一份作為 production fallback
COPY src       ./src
COPY dashboard ./dashboard

# workspace volume 掛載點，agent 操作檔案時用
RUN mkdir -p /workspace

WORKDIR /app

# 預設執行 server；可透過 docker-compose command 覆寫
ENTRYPOINT ["node", "dist/server/index.js"]
