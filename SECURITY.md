# 安全策略与隐私保护规范 (Security Policy)

## 1. 个人隐私与凭证安全设计

`PricePulse` 是一个**完全自托管（Self-hosted）**的开源项目，不会向任何外部第三方服务器传输您的账号凭证：

- **本地持久化隔离**：
  - 京东 / 淘宝登录态 Cookie：保存在运行设备本地的 `.local-data/PriceDrop/sessions/` 目录。
  - 飞书自定义机器人 Webhook 及签名密钥：保存在运行设备本地的 `.local-data/PriceDrop/data/feishu.json`。
  - 监控商品与历史价格流水：保存在运行设备本地的 `.local-data/PriceDrop/data/products.json`。
  - 无头浏览器 Profile：保存在 `.local-data/PriceDrop/browser-profiles/`。
- **Git 提交防护**：
  - `.gitignore` 已默认屏蔽 `.local-data/`、`*cookie*`、`*session*.json`、`*feishu*.json`、`.env` 等所有高敏路径。

## 2. 部署安全建议（私有服务器 / 私有云 / NAS）

1. **切勿直接裸奔暴露公网端口**：
   - 若部署在云服务器（VPS）或具备公网 IP 的 NAS 上，请务必通过反向代理（如 Nginx / Caddy / Lucky）配置 **HTTPS + Basic Auth / Authelia 访问鉴权**，或者仅通过 **Tailscale / ZeroTier / WireGuard 内网穿透** 访问 `8090` 端口。
2. **定期检查 `.gitignore`**：
   - 在提交 Pull Request 或 Fork 修改后执行 `git status` 时，请确认没有任何个人 `.json` 会话文件被纳入暂存区。

## 3. 报告安全漏洞 (Reporting a Vulnerability)

如果您在本项目中发现了潜在的安全漏洞（如 SSRF、越权访问、敏感信息泄露风险等）：

- **请勿直接在公开 Issue 中贴出未修复的漏洞利用细节或真实凭证**。
- 请通过 GitHub Security Advisories（**Security -> Report a vulnerability**）私密提交，维护者将在收到报告后尽快响应并修复。
