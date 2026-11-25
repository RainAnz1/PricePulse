# 京东 (JD.com) 网页扫码登录与会话持久化协议文档

> 基于京东官方登录页 (`https://passport.jd.com/new/login.aspx` 及 `login.qrcode.2024.js`) 协议整理，已完整接入 [`apps/api/src/sessions.ts`](../apps/api/src/sessions.ts) 与 [`apps/web/src/main.tsx`](../apps/web/src/main.tsx)。

---

## 1. 扫码登录全链路接口

### 1.1 获取登录二维码 (`qr.m.jd.com/show`)
- **请求方式**：`GET https://qr.m.jd.com/show?appid=133&size=147&t={timestamp}`
- **关键请求头**：
  - `Referer: https://passport.jd.com/new/login.aspx`
  - `User-Agent: Mozilla/5.0 ...`
- **响应内容**：
  - **Response Body**：二维码 PNG 图片二进制流 (`image/png`)
  - **Response Headers (`Set-Cookie`)**：
    - `QRCodeKey=<二维码唯一会话Key>; HttpOnly`
    - `wlfstk_smdl=<32位轮询Token>; PATH=/; DOMAIN=.jd.com`
    - `guid=<设备标识>; DOMAIN=.qr.m.jd.com`

### 1.2 轮询二维码扫描状态 (`qr.m.jd.com/check`)
- **请求方式**：`GET https://qr.m.jd.com/check?callback=jQuery{random}&appid=133&token={wlfstk_smdl}&_={timestamp}`
- **关键请求头**：
  - `Referer: https://passport.jd.com/new/login.aspx`
  - `Cookie: QRCodeKey={QRCodeKey}; wlfstk_smdl={wlfstk_smdl}`
- **响应体 (JSONP)**：
  - **`code: 201`（待扫码）**：
    ```json
    { "code": 201, "msg": "二维码未扫描，请扫描二维码" }
    ```
  - **`code: 202`（已扫码，待手机端确认）**：
    ```json
    { "code": 202, "msg": "请手机客户端确认登录" }
    ```
  - **`code: 200`（手机端已确认登录，返回 `ticket`）**：
    ```json
    { "code": 200, "ticket": "AAEAIE..." }
    ```
  - **`code: 203` / `204`（二维码已失效）**：
    ```json
    { "code": 203, "msg": "二维码已失效" }
    ```
  - **`code: 205`（手机端取消登录）**：
    ```json
    { "code": 205, "msg": "取消二维码登录" }
    ```

### 1.3 验证 Ticket 并换取正式登录 Cookie (`/uc/qrCodeTicketValidation`)
- **请求方式**：`GET https://passport.jd.com/uc/qrCodeTicketValidation?t={ticket}&pageSource=commonLogin&pageLocation=&ReturnUrl=https%3A%2F%2Fwww.jd.com%2F`
- **关键请求头**：
  - `Referer: https://passport.jd.com/new/login.aspx`
  - `Cookie: QRCodeKey={QRCodeKey}; wlfstk_smdl={wlfstk_smdl}`
  - `X-Requested-With: XMLHttpRequest`
- **响应体 (JSON)**：
  ```json
  { "returnCode": 0, "url": "https://www.jd.com/" }
  ```
- **响应头 (`Set-Cookie`)**：
  下发京东正式登录态 Cookie（`thor`、`pin`、`unick`、`pinId`、`_tp`、`TrackID`、`3AB9D23F7A4B3C9B` 等）。

### 1.4 校验登录态有效性 (`passport.jd.com/loginservice.aspx`)
- **请求方式**：`GET https://passport.jd.com/loginservice.aspx?method=Login&callback=jsonpLogin&_={timestamp}`
- **响应体 (JSONP)**：
  ```json
  jsonpLogin({
    "Identity": {
      "IsAuthenticated": true,
      "Unick": "example_user",
      "Name": "jd_xxxxxxxxxxxx"
    }
  })
  ```

---

## 2. 本项目后端接口与持久化路径

- **持久化文件位置**：`.local-data/PriceDrop/sessions/jd.json`（已被 `.gitignore` 忽略，不会泄露至 Git 仓库）
- **项目内部 API**：
  - `POST /api/sessions/jd/qrcode/start`：获取 base64 二维码图片与 `wlfstk_smdl` token
  - `GET /api/sessions/jd/qrcode/status`：轮询扫码状态，当 `code === 200` 时自动完成 Ticket 校验并落盘保存 Cookie
  - `GET /api/sessions/jd/status` & `POST /api/sessions/jd/check`：检查本地已保存的京东登录态有效性
