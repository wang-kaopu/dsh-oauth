# DSH OAuth Bridge

DSH OAuth Bridge 是一个 DeepSeek Harness 插件，通过浏览器 OAuth 接入 ChatGPT Codex 订阅和 Gemini Code Assist。

## 安装

直接将本包加入 DSH profile：

```sh
dsh plugin --profile web add @wang-kaopu/dsh-oauth
```

## 开发构建

```sh
npm install
npm run build
npm run check
npm test
```

`npm run build` 先用 `tsc` 生成 Node 端产物和声明文件，再用根目录的 `tsdown.config.ts` 生成 DSH 所需的 `lib/client.js` factory bundle 及 sourcemap。仅构建浏览器端可使用 `npm run bundle`，开发时可使用 `npm run watch:client`。

Gemini OAuth 使用 Google installed-app client。请通过环境变量提供 Google 为该客户端分配的凭据：

```sh
export GEMINI_CLIENT_ID="..."
export GEMINI_CLIENT_SECRET="..."
```

## Codex 登录

在 DSH UI 中选择 `Login with ChatGPT`，浏览器会打开 OpenAI OAuth 页面。回调完成后，令牌保存在 `$DSH_HOME/oauth-bridge.json`，并写入 DSH credential reference `DSH_OPENAI_CODEX_TOKEN`，由内置 `openai-codex` provider 发送模型请求。

## Gemini 登录

在 DSH UI 中选择 `Login with Google`。登录成功后插件会调用 Code Assist `loadCodeAssist`，新账号必要时会自动完成默认 tier 的 onboarding。非 FREE tier 需要 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID`。

## 支持范围

- Codex OAuth、PKCE、令牌刷新和登出。
- Gemini OAuth、Google OAuth 自动刷新、Code Assist 初始化和 SSE 文本/工具调用流。
- Gemini 模型目录默认提供 `gemini-2.5-pro` 和 `gemini-2.5-flash`。
- 本地 control server：`127.0.0.1:1456`，用于状态、登录和登出操作。

## 已知限制

- V0.1 只支持单账号；Gemini callback 端口由操作系统动态分配。
- Gemini 使用 Code Assist `v1internal` 接口，模型列表采用静态目录，不做远程发现。
- Gemini 暂不支持 reasoning effort；历史 reasoning block 会明确拒绝，不会降级为普通文本。
- 不包含额度、代理、Web Search、图像生成和 token revoke endpoint。

## 安全说明

令牌只写入权限为 `0600` 的 `$DSH_HOME/oauth-bridge.json`，写入采用原子替换并在读改写时加文件锁。control server 只监听 loopback，并拒绝非 loopback Origin。日志和 `/status` 都不会输出令牌或完整 OAuth 回调 URL。
