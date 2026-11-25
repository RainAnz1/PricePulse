# 贡献指南与开源协作规范 (Contributing Guide)

感谢你对 **PricePulse** 的关注与贡献！本项目处于长期持续迭代中，非常欢迎通过 Issue 或 Pull Request 参与共建。

---

## 1. 行为准则与开源边界

- **尊重与友善**：在 Issue 和 PR 讨论中保持专业、友善的技术交流氛围。
- **合规红线**：
  - 严禁提交任何绕过平台付费墙、恶意撞库、批量刷单或高并发攻击性质的代码。
  - **严禁在任何代码、测试用例、文档或截图中包含你自己的真实 Cookie（如 `thor`、`pt_key`、`wlfstk_smdl`）、手机号、账号 `pin` 或真实飞书 Webhook URL。**

---

## 2. 本地开发环境搭建

1. **环境要求**：Node.js >= 22，npm >= 10
2. **克隆与安装**：
   ```bash
   git clone https://github.com/RainAnz1/PricePulse.git
   cd PricePulse
   npm install
   ```
3. **启动开发服务**：
   ```bash
   npm run dev
   ```
   - 前端开发地址：`http://127.0.0.1:8090`
   - 后端 API 地址：`http://127.0.0.1:3001/api`
4. **提交前校验**：
   ```bash
   npm run typecheck
   npm run build
   node apps/api/test-product-url.cjs
   ```

---

## 3. Commit 提交规范

建议使用语义化 Commit Message（Conventional Commits）：

- `feat: 新增功能（如新增淘宝扫码登录、新增历史价格数据源）`
- `fix: 修复 Bug（如修复短链重定向解析失败）`
- `docs: 更新文档（如完善 NAS 部署说明或 PRD）`
- `refactor: 代码重构（不改变外部行为）`
- `chore: 构建脚本、依赖或配置文件调整`

---

## 4. 提交 Pull Request (PR) 清单

在发起 PR 前，请确认以下事项：

- [ ] `npm run typecheck` 与 `npm run build` 均无报错通过。
- [ ] 已运行 `git diff` 自查，确保**未夹带任何个人 Cookie、账号昵称、飞书 Webhook 或 `.local-data/` 下的文件**。
- [ ] 若新增了功能模块或配置项，已同步更新 `README.md` 或 `docs/` 下的设计文档。
