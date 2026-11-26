# PricePulse 容器化部署镜像 (支持 Linux 服务器 / 私有云 / 群晖・绿联・飞牛 NAS)
FROM node:22-bookworm-slim

WORKDIR /app

# 安装 Playwright Chromium 运行所需的基础系统依赖与中文字体
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    ca-certificates \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci

COPY . .

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

# 持久化目录：存放登录态 Cookie、监控商品与价格走势历史、飞书配置
VOLUME ["/app/.local-data"]

EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
