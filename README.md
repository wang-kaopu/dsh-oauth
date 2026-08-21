# DSH OAuth Bridge

DSH OAuth Bridge 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，通过浏览器 OAuth 将 **ChatGPT Codex** 与 **Gemini Code Assist** 订阅接入 DSH，无需手动配置对应模型的 API Key。

登录成功后，插件会根据认证状态动态挂载对应 provider；退出登录或凭据失效后，对应 provider 会自动撤销。

## Features

- **ChatGPT Codex OAuth**：使用 ChatGPT 订阅访问 Codex 模型。
- **Gemini Code Assist OAuth**：通过 Google OAuth 接入 Gemini Code Assist。
- **DSH Web UI 登录**：在 DSH 设置页中完成登录、状态查看与退出登录。
- **动态 Provider Route**：仅在对应账号已认证时向 DSH 暴露 provider。
- **Gemini 动态模型目录**：通过 Code Assist `retrieveUserQuota` 获取可用模型，并缓存最近一次成功结果。
- **安全凭据存储**：OAuth 凭据保存到 `$DSH_HOME/oauth-bridge.json`，文件权限为 `0600`。
- **本地 OAuth Control Server**：默认仅监听 `127.0.0.1:1456`，并限制非 loopback Origin。

## Providers

| Provider | Route | Subscription / Account | Authentication |
| --- | --- | --- | --- |
| Codex | `openai-codex` | ChatGPT subscription | ChatGPT OAuth |
| Gemini | `gemini-cli-oauth` | Gemini Code Assist | Google OAuth |

只有登录成功的 provider 才会出现在 DSH 中。

## Install

项目已发布到 npm：

```sh
npx @deepseek-ai/dsh plugin --profile web add @kelvinwww/dsh-oauth
```

安装完成后重新启动 `dsh web`，使插件加载到 Web profile。

## Use

1. 启动 DSH Web：

   ```sh
   dsh web
   ```

2. 打开浏览器中的 DSH 页面。
3. 进入设置页中的 **OAuth Providers / OAuth 登录**。
4. 根据需要选择：
   - **Login with ChatGPT**：连接 ChatGPT Codex。
   - **Login with Google**：连接 Gemini Code Assist。
5. OAuth 成功后，对应 provider 会自动注册到 DSH。
6. 退出登录后，插件会撤销对应 provider route。

## Configuration

插件支持以下配置：

| Option | Description | Default |
| --- | --- | --- |
| `dshHome` | 自定义 DSH Home 路径 | DSH 默认目录 |
| `controlPort` | 本地 OAuth control server 端口 | `1456` |
| `codexRedirectPort` | Codex OAuth redirect 端口 | 插件默认值 |

### Gemini OAuth credentials

使用 Gemini 前，需要提供 Google installed-app OAuth client：

```sh
export GEMINI_CLIENT_ID="..."
export GEMINI_CLIENT_SECRET="..."
```

对于非 FREE tier，还需要指定 Google Cloud Project：

```sh
export GOOGLE_CLOUD_PROJECT="your-project-id"
```

也可以使用：

```sh
export GOOGLE_CLOUD_PROJECT_ID="your-project-id"
```

## Authentication behavior

### Codex

Codex 登录状态会同步到 DSH 的 `openai-codex` provider route。

插件只会移除由自身创建并持有 ownership 标记的 Codex route，不会覆盖或删除用户自行配置的同名 route。

### Gemini

Gemini 使用独立的 `gemini-cli-oauth` Adapter。

登录成功后注册 Adapter；登出或确认 OAuth 凭据失效时撤销 Adapter。

Gemini 模型目录来自 Code Assist `retrieveUserQuota`，结果缓存 5 分钟。如果远端暂时失败或返回空目录，会优先复用最近一次成功获取的模型列表。

明确的 HTTP 401 或 OAuth `invalid_grant` 会被视为凭据已失效，此时插件会清理凭据并撤销对应 provider；临时网络或刷新错误不会立即清除登录状态。

## Security

OAuth token 与 Codex route ownership 元数据保存在：

```text
$DSH_HOME/oauth-bridge.json
```

存储文件权限为：

```text
0600
```

OAuth control server 默认监听：

```text
127.0.0.1:1456
```

Control API 仅允许 loopback 来源，包括：

- `localhost`
- `127.0.0.1`
- `::1`

## Limitations

当前版本：

- 仅支持单账号。
- Gemini OAuth callback 使用操作系统动态分配的端口。
- 暂不支持 reasoning effort。
- 暂不提供订阅额度展示。
- 暂不支持代理配置。
- 暂不支持 Web Search。
- 暂不支持图像生成。
- 暂不调用 token revoke endpoint。

## Develop

### Requirements

Node.js：

```text
^22.19.0 || >=24.11.0
```

### Install dependencies

```sh
npm install
```

### Build

```sh
npm run build
```

### Type check

```sh
npm run check
```

### Test

```sh
npm test
```

### Build browser bundle only

```sh
npm run bundle
```

### Watch browser bundle

```sh
npm run watch:client
```

## Project Layout

```text
src/
├── index.ts            # 插件入口、本地 control server、生命周期管理
├── routes.ts           # Codex / Gemini provider route 动态注册
├── codex.ts            # ChatGPT Codex OAuth 与服务逻辑
├── gemini.ts           # Gemini Code Assist OAuth、Adapter 与模型目录
├── storage.ts          # OAuth 凭据与 route ownership 持久化
├── client.tsx          # DSH Web 设置页 OAuth UI
└── client-locales.ts   # OAuth UI 中英文文案
```

## Package

npm package：

```text
@kelvinwww/dsh-oauth
```

插件入口同时导出 Gemini Adapter、Codex/Gemini service factory 与 storage API，便于测试和二次集成。
