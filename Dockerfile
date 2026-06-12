# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# npm ci 在 alpine (musl) 上會裝 copilot-linuxmusl-x64 binary
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# gh CLI — 讓容器內也能走 gh auth login (device flow)
RUN apk add --no-cache github-cli

# 複製 build 產物與 node_modules (含 copilot binary)
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# workspace volume 掛載點，agent 操作檔案時用
RUN mkdir -p /workspace
WORKDIR /workspace

ENV NODE_ENV=production

# 預設執行主程式；可透過 docker run 覆寫 CMD 執行其他 demo
ENTRYPOINT ["node", "/app/dist/index.js"]
