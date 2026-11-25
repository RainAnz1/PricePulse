# PricePulse（价格脉搏 · 价格观察室）

<p align="left">
  <img src="https://img.shields.io/badge/License-MIT-26734f.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-46a377.svg" alt="Node.js >= 22" />
  <img src="https://img.shields.io/badge/Self--Hosted-Server%20%7C%20NAS%20%7C%20Docker-1f6c4d.svg" alt="Self-Hosted" />
  <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

**PricePulse** 是一个完全自托管（Self-Hosted）、可持续演进的**网购商品实时盯盘、国补与优惠券折算、价格走势追踪及飞书 Webhook 实时推送平台**（支持京东 & 淘宝/天猫）。

只需复制商品链接粘贴到网页中，即可实时解析当前页面标价、自动识别可用的**店铺券 / 平台满减券**与**国家补贴（15% / 20% 国补）**，计算出最优预估到手价，并在商品降价、下架或登录态过期时第一时间推送富文本卡片到你的飞书群。

---

## 🖼️ 界面预览 (UI Screenshots)

### 1. 主页 · 商品实时价格监控与交互式走势图
> 支持一键解析商品标价、满减优惠券、15%/20% 国家补贴（国补）折算到手价，内置 Apple「股市」级交互式价格走势图（支持鼠标移入十字准星看盘、滚轮无级缩放与时间区间联动筛选）。

![商品实时价格监控](./docs/images/dashboard-home.png)

### 2. 平台账号与服务端长效会话
> 集中管理京东与淘宝/天猫登录态，支持网页内二维码扫码或手机号短信验证码直登，Cookie 持久化保存在服务端本地并定时自动保活。

![平台账号与服务端会话](./docs/images/platform-sessions.png)

### 3. 飞书 Webhook 实时卡片推送设置
> 接入飞书群自定义机器人 Webhook，针对商品降价、优惠券/国补变动、商品下架断货及登录态失效实时发送富文本通知卡片。

![飞书 Webhook 推送设置](./docs/images/feishu-webhook.png)

### 4. 飞书群降价通知推送效果
> 当商品触发降价或刷新史低时，飞书机器人自动推送交互式富文本卡片，直观呈现降价前价格 vs 当前最优到手价、直降金额与比例、页面标价/券后价/国补价三阶拆解、史低对比及一键直达商品页按钮。

![飞书降价通知推送效果](./docs/images/feishu-push-card.png)

---

## ✨ 核心特性

- **🔗 链接即贴即查（支持分享短链）**：直接复制京东、淘宝/天猫商品链接或 App 分享口令中的短链（如 `3.cn`、`u.jd.com`）粘贴到网页，即刻解析商品信息与当前实时价格。
- **🟢 国补价与优惠券全面拆解**：
  - 自动抓取商品可领用的**店铺满减券、平台神券、PLUS / 88VIP 会员立减**。
  - 自动识别商品是否参与**国家补贴 / 政府消费补贴（国补）**（如手机/数码 3C 类目 15% 最高补 ¥500、家电/电脑类目 20% 最高补 ¥2000），清晰对比「页面标价」、「券后价」与「国补后到手价」。
- **📈 交互式历史价格走势图**：优先获取或构建商品历史价格轨迹，实时记录每次巡检价格；支持在同一张 SVG 折线图中对比**最优到手价曲线**、**页面标价曲线**与**史低价基准线**。
- **🔐 网页内扫码 / 手机号验证码双登录 & 服务端长效保活**：
  - 无需在服务器上弹桌面浏览器窗口，直接在 PricePulse 网页内展示**京东官方登录二维码**或使用**手机号+短信验证码**登录。
  - 登录成功后二维码实时自动关闭，Cookie 与会话凭证持久化保存在你自己的服务端本地（`.local-data/`），内置 10 分钟定时保活心跳，刷新页面或重启服务均不掉线。
- **🔔 飞书 Webhook 实时富文本卡片推送**：
  - **商品降价 / 新出神券 / 国补开启推送**：直观对比降价前价格 vs 当前到手价、直降金额与降幅比例、优惠券与国补明细，以及距离史低价的差距。
  - **商品下架 / 无货提醒**：盯盘商品断货或下架时即时通知。
  - **平台登录态失效告警**：Cookie 过期或触发安全验证时自动推送飞书提醒。
- **⚖️ 全网实时自动比价（持续迭代中）**：规划支持同一件商品跨店铺、跨平台（京东 ↔ 淘宝）实时比价，自动定位全网最低到手渠道。

---

## 🤖 一键让你的 AI Agent 自动部署（私有服务器 / 私有云 / NAS）

你可以直接把下面这段提示词复制发给你的 **AI Agent**（如 **Claude Code、Cursor、Codex、Antigravity、OpenClaw、Cline** 等），让 Agent 自动帮你把本项目部署到你的 **Linux 私有服务器、私有云、Mac mini 家庭服务器，或群晖 (Synology) / 绿联 (UGREEN) / 飞牛 (fnOS) / 威联通 (QNAP) NAS** 上：

### 📋 复制以下 Prompt 发给你的 Agent：

```markdown
请帮我将开源项目 PricePulse 部署到当前设备（私有服务器 / 私有云 / NAS）上，仓库地址为：
https://github.com/RainAnz1/PricePulse.git

请按以下步骤自动完成环境检查与部署：
1. 克隆仓库到本地目录：
   git clone https://github.com/RainAnz1/PricePulse.git && cd PricePulse
2. 选择最适合当前机器的部署方式：
   - 【方式 A：Docker / NAS 容器部署（推荐用于群晖、绿联、飞牛 fnOS、威联通 NAS 或已安装 Docker 的服务器）】
     直接执行 `docker compose up -d --build`，确认容器 `price-pulse` 启动成功，并将 `./local-data` 挂载至容器内 `/app/.local-data` 以持久化保存京东/淘宝登录态 Cookie、监控商品历史价格和飞书 Webhook 配置。
   - 【方式 B：Node.js 原生常驻部署（适用于已有 Node.js >= 22 的服务器或 Mac / Linux 主机）】
     执行 `npm install && npm run build`，并使用 PM2、systemd 或后台进程启动服务，确保前端 `8090` 端口与后端 `3001` 端口正常监听。
3. 部署完成后，请执行 `curl -s http://127.0.0.1:3001/api/health` 验证后端健康状态，并告诉我在局域网或内网穿透下的 Web 访问地址（默认端口 `8090`）。
```

---

## 🛠️ 手动安装与部署指南

### 方式一：本地 / 私有服务器直接运行 (Node.js >= 22)

```bash
# 1. 克隆仓库
git clone https://github.com/RainAnz1/PricePulse.git
cd PricePulse

# 2. 安装依赖
npm install

# 3. 启动服务（前端端口 8090，后端 API 端口 3001）
npm run dev
```

启动后在浏览器访问：**http://127.0.0.1:8090**

- **类型检查**：`npm run typecheck`
- **生产构建**：`npm run build`
- **链接解析自测**：`node apps/api/test-product-url.cjs`

### 方式二：Docker / NAS（群晖 / 绿联 / 飞牛 fnOS / Unraid）部署

```bash
git clone https://github.com/RainAnz1/PricePulse.git
cd PricePulse
docker compose up -d --build
```

- **Web 面板端口**：`http://<你的NAS或服务器IP>:8090`
- **数据持久化目录**：当前目录下的 `./local-data`（包含你的扫码登录 Cookie、商品历史价格及飞书 Webhook 配置，容器升级或重启不会丢失）。

---

## 🔒 隐私与数据安全说明

1. **零第三方上传**：你在网页端扫码或验证码登录获取的京东/淘宝 Cookie、飞书 Webhook 密钥仅保存在你部署设备本地的 `.local-data/` 目录下，绝不经过任何第三方中转服务器。
2. **严格的 `.gitignore` 防护**：仓库已默认忽略所有 `.local-data/`、`*cookie*`、`*session*.json`、`*feishu*.json`、`.env` 等敏感文件，防止在二次开发或提交 PR 时意外泄露个人凭证。
3. **公网部署建议**：若将本项目部署在有公网 IP 的云服务器上，请配合 Nginx / Caddy / Lucky 开启 Basic Auth 访问密码或仅通过 Tailscale / WireGuard 内网访问，切勿将已登录个人电商账号的面板无鉴权暴露在公网。详见 [SECURITY.md](./SECURITY.md)。

---

## 📚 项目文档与路线图

项目长期迭代的需求与协议文档位于 [`docs/`](./docs/) 目录：

- [📋 产品需求文档与迭代路线图 (PRD & Roadmap)](./docs/requirements.md)
- [🔐 京东网页扫码与会话持久化协议说明](./docs/jd-auth-protocol.md)
- [🤝 贡献指南 (CONTRIBUTING.md)](./CONTRIBUTING.md)
- [🛡️ 安全策略与隐私规范 (SECURITY.md)](./SECURITY.md)

---

## 📄 开源许可证 (License)

本项目基于 [MIT License](./LICENSE) 开源。仅限个人学习、技术研究与自用价格监控，请遵守目标电商平台服务协议，合理控制请求频率。
