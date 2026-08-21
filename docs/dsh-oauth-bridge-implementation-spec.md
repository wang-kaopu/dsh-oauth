# DSH OAuth Bridge 插件实现规格

> 目标：实现一个 DeepSeek Harness（DSH）第三方插件，通过 **OAuth 认证**接入：
>
> 1. **OpenAI Codex / ChatGPT 订阅**
> 2. **Gemini CLI / Gemini Code Assist**
>
> 不使用 API Key。
>
> 不通过 `spawn`、`exec`、`child_process`、`execa` 调用 Codex CLI 或 Gemini CLI。
>
> 插件必须自己完成 OAuth 登录、Token 持久化与刷新，并直接通过 HTTP/SDK 与上游服务通信。
>
> 本文是实现规格。Agent 应严格按本文实现，不要自行扩展架构，不要增加无关抽象。

---

# 1. 总体设计

采用两条不同实现路径。

```text
                         dsh-oauth-bridge
                               │
              ┌────────────────┴────────────────┐
              │                                 │
            Codex                          Gemini CLI
              │                                 │
        只负责 OAuth                  OAuth + Code Assist
              │                                 │
              ▼                                 ▼
 OAuth 状态驱动的 openai-codex route     OAuth 状态驱动的 GeminiCliAdapter route
              │                                 │
              ▼                                 ▼
     ChatGPT Codex backend        cloudcode-pa.googleapis.com
```

## 1.1 Codex

Codex **不要自己实现 LLM Adapter**。

插件只负责：

```text
OAuth 登录
→ 保存 access_token / refresh_token
→ 自动刷新
→ 将 access_token 写入 DSH Credentials
→ 通过 `ctx.settings.mutate()` 动态写入 `llm-pi-ai.providers.openai-codex`
→ DSH 内置 openai-codex Provider 完成模型请求
```

DSH 内置 `llm-pi-ai` 已经负责：

```text
DSH GenerateOptions
→ Codex Responses 请求格式
→ ChatGPT Codex backend
→ SSE
→ DSH StreamChunk
```

因此插件不允许重复实现：

- Codex LlmAdapter
- Codex message 转换
- Codex tool call 转换
- Codex reasoning 转换
- Codex 模型 SSE → DSH StreamChunk
- Codex 模型列表协议

---

## 1.2 Gemini CLI

Gemini CLI 当前不能复用 DSH 内置 Codex Provider，因此插件自己实现：

```text
Google OAuth
→ Token 保存
→ Google OAuth 自动 refresh
→ loadCodeAssist
→ 必要时 onboardUser
→ streamGenerateContent
→ Gemini SSE 解析
→ 转换 DSH StreamChunk
```

---

# 2. 非目标

以下功能 V0.1 **禁止实现**：

```text
API Key
自定义 OpenAI Compatible Endpoint
spawn Codex CLI
spawn Gemini CLI
exec
child_process
execa
多账号
账号切换
额度面板
Web Search
Image Generation
代理配置 UI
Provider Registry
Provider Factory
BaseProvider
AbstractOAuthProvider
复杂依赖注入框架
数据库
Redis
远程服务
```

只做：

```text
Codex OAuth
Gemini OAuth
Gemini Code Assist Adapter
简单登录状态 UI
```

---

# 3. 技术栈

运行时：

```text
Node.js ^22.19.0 || >=24.11.0
TypeScript
ESM
```

需要的依赖：

```json
{
  "dependencies": {
    "@deepseek-ai/cordis": "<与目标 DSH 版本一致>",
    "@deepseek-ai/dsh-credentials": "<与目标 DSH 版本一致>",
    "@deepseek-ai/dsh-llm": "<与目标 DSH 版本一致>",
    "@deepseek-ai/dsh-home-paths": "<与目标 DSH 版本一致>",
    "@deepseek-ai/dsh-atomic-write": "<与目标 DSH 版本一致>",
    "google-auth-library": "10.9.0"
  }
}
```

可选：

```json
{
  "@google/genai": "1.30.0"
}
```

`@google/genai` 第一版只允许用于 TypeScript 类型定义。

禁止直接使用：

```text
openai
@google/gemini-cli
@google/gemini-cli-core
execa
open
```

---

# 4. 项目目录

固定使用：

```text
dsh-oauth-bridge/
├── package.json
├── tsconfig.json
├── cordis.patch.yml
│
└── src/
    ├── index.ts
    ├── storage.ts
    ├── codex.ts
    ├── gemini.ts
    ├── client.tsx
    └── client-locales.ts
```

不要增加：

```text
provider/
repository/
factory/
manager/
service/
strategy/
domain/
infrastructure/
```

除非单文件确实超过约 800 行且已经难以维护。

---

# 5. Credential 文件

文件路径：

```text
$DSH_HOME/oauth-bridge.json
```

结构：

```json
{
  "version": 1,
  "codex": {
    "accessToken": "...",
    "refreshToken": "...",
    "idToken": "...",
    "expiresAt": 1787000000000,
    "accountId": "..."
  },
  "gemini": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1787000000000,
    "projectId": "..."
  }
}
```

TypeScript：

```ts
export interface CodexCredential {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
  accountId: string
}

export interface GeminiCredential {
  accessToken?: string
  refreshToken: string
  expiresAt?: number
  projectId?: string
}

export interface CredentialDocument {
  version: 1
  codex?: CodexCredential
  gemini?: GeminiCredential
}
```

---

# 6. storage.ts

只负责 Credential 文件。

必须导出：

```ts
loadDocument()
saveDocument(document)

loadCodexCredential()
saveCodexCredential(credential)
clearCodexCredential()

loadGeminiCredential()
saveGeminiCredential(credential)
clearGeminiCredential()
```

要求：

1. 使用 `$DSH_HOME/oauth-bridge.json`
2. 写入必须使用原子写
3. 不允许把 Token 打进日志
4. 文件不存在时返回空 document
5. JSON 损坏时抛出明确错误
6. refresh 后如果上游没有返回新的 `refresh_token`，必须保留旧 refresh token

示例：

```ts
const old = await loadGeminiCredential()

await saveGeminiCredential({
  ...old,
  ...newTokens,
  refreshToken:
    newTokens.refreshToken ??
    old?.refreshToken,
})
```

---

# 7. Codex 实现

文件：

```text
src/codex.ts
```

---

# 8. Codex OAuth 常量

定义：

```ts
const CODEX_CLIENT_ID =
  'app_EMoamEEZ73f0CkXaXp7hrann'

const CODEX_ISSUER =
  'https://auth.openai.com'

const CODEX_AUTHORIZE_URL =
  `${CODEX_ISSUER}/oauth/authorize`

const CODEX_TOKEN_URL =
  `${CODEX_ISSUER}/oauth/token`

const CODEX_REDIRECT_PORT = 1455

const CODEX_REDIRECT_URI =
  `http://localhost:${CODEX_REDIRECT_PORT}/auth/callback`
```

不要把这些散落在代码中。

---

# 9. Codex OAuth PKCE

使用 Node：

```ts
import {
  createHash,
  randomBytes,
} from 'node:crypto'
```

生成：

```ts
function createPkce() {
  const verifier =
    randomBytes(32).toString('base64url')

  const challenge =
    createHash('sha256')
      .update(verifier)
      .digest('base64url')

  return {
    verifier,
    challenge,
  }
}
```

state：

```ts
const state =
  randomBytes(32).toString('base64url')
```

---

# 10. Codex authorize URL

生成的 authorize URL 至少包含：

```text
response_type=code
client_id=<CODEX_CLIENT_ID>
redirect_uri=http://localhost:1455/auth/callback
code_challenge=<challenge>
code_challenge_method=S256
state=<state>
```

scope：

```text
openid
profile
email
offline_access
api.connectors.read
api.connectors.invoke
```

组合：

```ts
const scope = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke',
].join(' ')
```

还需要：

```text
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=codex_cli_rs
```

---

# 11. Codex 登录流程

暴露：

```ts
startCodexLogin(): Promise<{
  authUrl: string
}>
```

流程：

```text
startCodexLogin()
      │
      ├── 创建 PKCE
      ├── 创建 state
      ├── 启动 localhost:1455
      ├── 保存本次登录临时状态
      └── 返回 authUrl
```

注意：

插件后端 **不得**：

```ts
open(authUrl)
spawn('open')
exec(...)
```

由 DSH Client：

```ts
window.open(authUrl, '_blank')
```

---

# 12. Codex Callback Server

Node：

```ts
import { createServer } from 'node:http'
```

监听：

```text
127.0.0.1 / localhost
port 1455
path /auth/callback
```

收到 callback：

```text
/auth/callback?code=XXX&state=XXX
```

必须：

```text
1. 验证 path
2. 检查 error
3. 验证 state
4. 检查 code
5. exchange code
6. 保存 token
7. 更新 ctx.credentials
8. 返回成功 HTML
9. 关闭 callback server
```

state 不匹配：

```text
HTTP 400
CODEX_OAUTH_STATE_MISMATCH
```

---

# 13. Codex Authorization Code Exchange

请求：

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
```

body：

```text
grant_type=authorization_code
client_id=<CLIENT_ID>
code=<CODE>
redirect_uri=http://localhost:1455/auth/callback
code_verifier=<PKCE_VERIFIER>
```

使用 Node 原生：

```ts
fetch()
```

不要安装 OpenAI SDK。

返回至少读取：

```ts
interface CodexTokenResponse {
  access_token: string
  refresh_token: string
  id_token?: string
  expires_in?: number
}
```

计算：

```ts
expiresAt =
  Date.now()
  + expires_in * 1000
```

---

# 14. Codex accountId

需要从 JWT payload 读取 ChatGPT account ID。

只 decode，不做 JWT signature verification。

实现：

```ts
function decodeJwtPayload(token: string) {
  const parts = token.split('.')

  if (parts.length !== 3) {
    return undefined
  }

  try {
    return JSON.parse(
      Buffer
        .from(parts[1], 'base64url')
        .toString('utf8')
    )
  } catch {
    return undefined
  }
}
```

优先读取：

```ts
claims?.[
  'https://api.openai.com/auth'
]?.chatgpt_account_id
```

fallback：

```text
claims.chatgpt_account_id
claims.organizations[0].id
idToken 对应 claim
```

取不到 accountId：

```text
CODEX_ACCOUNT_ID_MISSING
```

登录失败。

---

# 15. Codex Token 保存

保存：

```ts
{
  accessToken,
  refreshToken,
  idToken,
  expiresAt,
  accountId,
}
```

然后立即写入 DSH Credential：

```ts
import {
  credentialRef
} from '@deepseek-ai/dsh-credentials'

const CODEX_TOKEN_REF =
  credentialRef(
    'DSH_OPENAI_CODEX_TOKEN'
  )

await ctx.credentials.set(
  CODEX_TOKEN_REF,
  accessToken,
)
```

---

# 16. Codex Refresh

导出：

```ts
getCodexAccessToken(ctx):
  Promise<string>
```

逻辑：

```text
读取 credential
      │
      ├── 不存在
      │      ↓
      │ CODEX_AUTH_REQUIRED
      │
      └── 存在
             │
             ▼
expiresAt > now + 60s ?
        │
     Yes│        No
        │         │
        ▼         ▼
     返回 token   refresh
                   │
                   ▼
               保存 token
                   │
                   ▼
          ctx.credentials.set()
```

refresh：

```http
POST https://auth.openai.com/oauth/token
```

body：

```text
grant_type=refresh_token
client_id=<CLIENT_ID>
refresh_token=<REFRESH_TOKEN>
```

如果 refresh response 没有新 `refresh_token`：

```ts
refreshToken =
  response.refresh_token ??
  old.refreshToken
```

永久失效类 refresh 错误：

```text
refresh_token_expired
refresh_token_reused
refresh_token_invalidated
```

处理：

```text
清除 Codex credential
ctx.credentials.unset(CODEX_TOKEN_REF)
抛 CODEX_AUTH_REQUIRED
```

不要无限 retry。

---

# 17. Codex Provider 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: oauth-bridge
      name: "@YOUR_SCOPE/dsh-oauth-bridge"
```

未认证时不声明 Codex profile。登录后由 route manager 写入并在登出时撤销：

```text
authenticated → set providers.openai-codex.apiKeyEnv
logout        → unset providers.openai-codex
```

`openai-codex` 仍由 DSH 内置 `llm-pi-ai` 提供，插件不注册自定义 Codex adapter。

route manager 会持久化 ownership marker，并用 `settings` revision 保护写入：已有用户 profile 不会被覆盖；只有本插件创建且仍保持原始 profile 的 route 才会在 logout 时删除。用户在插件创建后修改过的 route 会被保留，并解除插件 ownership。

---

# 18. Codex 模型调用禁止实现

不要在插件里调用：

```text
https://chatgpt.com/backend-api/codex/responses
```

用于 DSH 普通模型聊天。

模型聊天必须交给：

```text
DSH llm-pi-ai
→ openai-codex
```

插件只负责 OAuth token。

---

# 19. Gemini 实现

文件：

```text
src/gemini.ts
```

职责：

```text
OAuth
Token 加载
Token refresh
Code Assist setup
streamGenerateContent
SSE parsing
DSH StreamChunk conversion
```

---

# 20. Gemini OAuth SDK

必须使用：

```ts
import {
  OAuth2Client,
} from 'google-auth-library'
```

不要自己手写：

```text
oauth2.googleapis.com/token
```

refresh。

---

# 21. Gemini OAuth Scopes

使用：

```ts
const GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]
```

必须：

```text
access_type=offline
```

保证能拿 refresh token。

---

# 22. Gemini OAuth Client

实现：

```ts
function createGeminiOAuthClient() {
  return new OAuth2Client({
    clientId:
      GEMINI_CLIENT_ID,

    clientSecret:
      GEMINI_CLIENT_SECRET,
  })
}
```

关于 `GEMINI_CLIENT_ID` / `GEMINI_CLIENT_SECRET`：

1. 代码结构必须允许配置
2. 不要散落硬编码
3. 如果复用 Gemini CLI 当前公开 installed-app OAuth client，只能作为兼容实现
4. 不允许伪装/绕过 Google 服务策略
5. 如果 Google 拒绝第三方使用，应报错，不尝试规避

---

# 23. Gemini Callback Port

Gemini 不固定 1455。

实现：

```ts
getAvailablePort(): Promise<number>
```

Node：

```ts
import * as net from 'node:net'
```

通过：

```ts
server.listen(0)
```

让 OS 分配端口。

redirect URI：

```ts
const redirectUri =
  `http://127.0.0.1:${port}/oauth2callback`
```

必须使用 loopback。

---

# 24. Gemini Login

暴露：

```ts
startGeminiLogin(): Promise<{
  authUrl: string
}>
```

流程：

```text
创建 OAuth2Client
→ 找可用 port
→ 创建 state
→ 创建 callback server
→ generateAuthUrl()
→ 返回 authUrl
```

生成 URL：

```ts
const authUrl =
  client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    scope: GEMINI_SCOPES,
    state,
  })
```

前端：

```ts
window.open(authUrl, '_blank')
```

后端禁止 `open()`。

---

# 25. Gemini Callback

收到：

```text
/oauth2callback?code=...&state=...
```

必须：

```text
验证 state
→ client.getToken()
→ client.setCredentials()
→ 保存 credential
→ fetch / resolve Code Assist setup
→ 返回成功页
→ 关闭 callback server
```

code exchange：

```ts
const { tokens } =
  await client.getToken({
    code,
    redirect_uri: redirectUri,
  })
```

保存：

```ts
{
  accessToken:
    tokens.access_token ?? undefined,

  refreshToken:
    tokens.refresh_token!,

  expiresAt:
    tokens.expiry_date ?? undefined,
}
```

第一次登录拿不到 refresh token：

```text
GEMINI_REFRESH_TOKEN_MISSING
```

视为登录失败。

---

# 26. Gemini OAuth Client 恢复

应用启动后：

```ts
const stored =
  await loadGeminiCredential()

const client =
  createGeminiOAuthClient()

client.setCredentials({
  access_token:
    stored.accessToken,

  refresh_token:
    stored.refreshToken,

  expiry_date:
    stored.expiresAt,
})
```

以后：

```ts
const { token } =
  await client.getAccessToken()
```

让 `google-auth-library` 自动 refresh。

不要手写 refresh token 请求。

---

# 27. Gemini Token 持久化更新

`OAuth2Client` refresh 后可能产生新的 credential。

监听：

```ts
client.on(
  'tokens',
  async (tokens) => {
    // merge save
  }
)
```

必须 merge：

```ts
const old =
  await loadGeminiCredential()

await saveGeminiCredential({
  ...old,

  accessToken:
    tokens.access_token ??
    old?.accessToken,

  refreshToken:
    tokens.refresh_token ??
    old?.refreshToken,

  expiresAt:
    tokens.expiry_date ??
    old?.expiresAt,
})
```

不要因为刷新响应没有 `refresh_token` 就覆盖掉旧值。

---

# 28. Gemini Code Assist Endpoint

常量：

```ts
const CODE_ASSIST_ENDPOINT =
  'https://cloudcode-pa.googleapis.com'

const CODE_ASSIST_API_VERSION =
  'v1internal'
```

method URL：

```ts
function getMethodUrl(
  method: string
) {
  return (
    `${CODE_ASSIST_ENDPOINT}/`
    + `${CODE_ASSIST_API_VERSION}:`
    + method
  )
}
```

示例：

```text
https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist

https://cloudcode-pa.googleapis.com/v1internal:onboardUser

https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent
```

---

# 29. Gemini authenticated request

不要手动拼 Authorization Header。

必须使用：

```ts
client.request()
```

例如：

```ts
const res =
  await client.request({
    url:
      getMethodUrl(
        'loadCodeAssist'
      ),

    method: 'POST',

    headers: {
      'Content-Type':
        'application/json',
    },

    body:
      JSON.stringify(body),
  })
```

OAuth SDK 自动提供 Bearer Token 和 refresh。

---

# 30. Code Assist 初始化

登录成功后不能直接假设可以聊天。

必须执行：

```text
loadCodeAssist
```

实现：

```ts
ensureGeminiCodeAssistSetup(
  client
): Promise<{
  projectId: string
}>
```

优先 project：

```ts
process.env.GOOGLE_CLOUD_PROJECT
||
process.env.GOOGLE_CLOUD_PROJECT_ID
||
stored.projectId
||
undefined
```

不能把纯数字 project number 当 project ID。

纯数字：

```text
GEMINI_INVALID_PROJECT_ID
```

---

# 31. loadCodeAssist

请求 body：

```ts
const metadata = {
  ideType:
    'IDE_UNSPECIFIED',

  platform:
    'PLATFORM_UNSPECIFIED',

  pluginType:
    'GEMINI',
}

const request = {
  cloudaicompanionProject:
    projectId,

  metadata: {
    ...metadata,

    ...(projectId
      ? {
          duetProject:
            projectId,
        }
      : {}),
  },
}
```

调用：

```text
POST /v1internal:loadCodeAssist
```

---

# 32. loadCodeAssist 返回处理

情况 A：

```text
currentTier 存在
```

如果返回：

```text
cloudaicompanionProject
```

直接使用。

否则如果本地 `projectId` 存在：

```text
使用本地 projectId
```

否则：

```text
GEMINI_PROJECT_REQUIRED
```

---

# 33. Gemini Onboarding

如果：

```text
currentTier 不存在
```

读取：

```text
allowedTiers
```

选择：

```text
isDefault === true
```

如果没有：

```text
GEMINI_NO_ALLOWED_TIER
```

调用：

```text
POST /v1internal:onboardUser
```

FREE tier：

```ts
{
  tierId:
    tier.id,

  metadata: {
    ideType:
      'IDE_UNSPECIFIED',

    platform:
      'PLATFORM_UNSPECIFIED',

    pluginType:
      'GEMINI',
  }
}
```

非 FREE：

```ts
{
  tierId:
    tier.id,

  cloudaicompanionProject:
    projectId,

  metadata: {
    ideType:
      'IDE_UNSPECIFIED',

    platform:
      'PLATFORM_UNSPECIFIED',

    pluginType:
      'GEMINI',

    duetProject:
      projectId,
  }
}
```

---

# 34. Gemini Onboarding LRO

如果：

```json
{
  "done": false,
  "name": "operations/xxx"
}
```

则轮询：

```text
GET
https://cloudcode-pa.googleapis.com/v1internal/{operationName}
```

每：

```text
5 秒
```

最多：

```text
60 秒
```

如果超时：

```text
GEMINI_ONBOARDING_TIMEOUT
```

不要无限轮询。

---

# 35. Gemini setup 结果缓存

成功后保存：

```ts
credential.projectId =
  resolvedProjectId
```

写入 credential 文件。

内存中允许缓存：

```text
projectId
```

但 token 不要只存内存。

---

# 36. Gemini LlmAdapter

实现：

```ts
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
```

类：

```ts
export class GeminiCliAdapter
  extends LlmAdapter {

  async *stream(
    options: GenerateOptions
  ): AsyncIterable<StreamChunk> {
    // implementation
  }
}
```

注册 provider：

```text
gemini-cli-oauth
```

---

# 37. Gemini Adapter 注册

`index.ts` 中保留 adapter 实例，但只在 OAuth 成功后挂载 route：

```ts
const syncGeminiRoute = createGeminiRouteSync(ctx, new GeminiCliAdapter(gemini))
// 未登录：不 registerAdapter
// 登录：registerAdapter(['gemini-cli-oauth'], adapter)
// 登出：registration.replace([])
```

Codex 不注册自定义 adapter。

---

# 38. Gemini listModels

模型目录来自 Code Assist `retrieveUserQuota` 的 `buckets[].modelId`，不维护静态白名单：

实现：

```ts
async listModels(provider: string) {
  if (
    provider !==
    'gemini-cli-oauth'
  ) {
    return []
  }

  const response = await requestJson({
    url: getMethodUrl('retrieveUserQuota'),
    method: 'POST',
    body: JSON.stringify({ project }),
  })
  return uniqueNonEmptyModelIds(response.buckets)
}
```

结果按模型 ID 去重并过滤空值；缓存 5 分钟，登出、project 变化和认证失效时清空，并通过 generation 防止旧账号的 in-flight 请求污染新账号。远端临时失败或成功返回空目录时可复用最近一次成功结果，并通过 single-flight 避免并发重复请求。模型 ID 保持原值发送请求，只对显示名称做格式化。Gemini 请求明确返回 401 或 OAuth `invalid_grant` 时清除凭据并撤销 provider route；临时刷新失败不改变已登录状态。

---

# 39. Gemini DSH Request → Code Assist Request

输入：

```ts
GenerateOptions
```

输出：

```ts
interface CAGenerateContentRequest {
  model: string
  project?: string
  user_prompt_id?: string
  request: {
    contents: unknown[]
    systemInstruction?: unknown
    tools?: unknown[]
    generationConfig?: unknown
    session_id?: string
  }
}
```

---

# 40. contents 转换

DSH messages 至少处理：

```text
user
assistant
tool result
```

Gemini：

```ts
{
  role: 'user',
  parts: [
    {
      text: 'hello'
    }
  ]
}
```

assistant：

```ts
{
  role: 'model',
  parts: [
    {
      text: 'hello'
    }
  ]
}
```

工具调用：

```ts
{
  role: 'model',
  parts: [
    {
      functionCall: {
        name: 'tool_name',
        args: {}
      }
    }
  ]
}
```

工具结果：

```ts
{
  role: 'user',
  parts: [
    {
      functionResponse: {
        name: 'tool_name',
        response: {}
      }
    }
  ]
}
```

Agent 必须对照目标 DSH 版本 `GenerateOptions.messages` 的实际类型实现，不允许猜测字段。

---

# 41. systemInstruction

如果 DSH 有 system prompt：

```ts
{
  role: 'user',
  parts: [
    {
      text: systemPrompt
    }
  ]
}
```

放：

```text
request.systemInstruction
```

不要混入 contents 第一条 user message。

---

# 42. tools 转换

DSH Tool：

```text
name
description
input schema
```

转换为 Gemini function declaration：

```ts
{
  functionDeclarations: [
    {
      name:
        tool.name,

      description:
        tool.description,

      parameters:
        tool.inputSchema,
    }
  ]
}
```

注意目标 Gemini schema 与 DSH tool schema 差异。

如果 schema 有 Gemini 不支持字段：

```text
做最小兼容转换
```

不要静默完全丢掉 tool。

---

# 43. generationConfig

映射支持字段：

```text
temperature
topP
topK
maxOutputTokens
stopSequences
```

不支持的 DSH option：

```text
明确 LlmError
```

不要静默忽略重要生成参数。

---

# 44. streamGenerateContent

URL：

```text
https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent
```

query：

```text
alt=sse
```

调用：

```ts
const res =
  await client.request({
    url:
      getMethodUrl(
        'streamGenerateContent'
      ),

    method: 'POST',

    params: {
      alt: 'sse',
    },

    headers: {
      'Content-Type':
        'application/json',

      ...attributionHeaders(),
    },

    responseType:
      'stream',

    body:
      JSON.stringify(request),

    signal:
      options.signal,

    retry: false,
  })
```

如果 `google-auth-library` 对额外 attribution header 有行为差异，以兼容 DSH 要求为优先。

---

# 45. SSE Parser

不要引入复杂 SSE 框架。

实现：

```ts
async function* parseSse(
  stream
) {
  // line based parser
}
```

规则：

```text
遇到 "data: "
→ 保存 data 内容

遇到空行
→ join buffered data
→ JSON.parse
→ yield object

忽略：
event:
id:
:
```

伪代码：

```ts
let lines: string[] = []

for await (
  const line of lineReader
) {
  if (
    line.startsWith('data: ')
  ) {
    lines.push(
      line
        .slice(6)
        .trim()
    )

    continue
  }

  if (
    line === ''
    && lines.length > 0
  ) {
    const json =
      lines.join('\n')

    lines = []

    yield JSON.parse(json)
  }
}
```

malformed chunk：

```text
跳过 + debug log
```

日志中不要输出完整用户内容。

---

# 46. Gemini Response 外层结构

Code Assist event 大致：

```ts
{
  response?: {
    candidates?: [],
    usageMetadata?: {},
    modelVersion?: string
  },

  traceId?: string
}
```

先取：

```ts
const response =
  event.response
```

---

# 47. Gemini Text → DSH StreamChunk

第一次出现文本：

```ts
yield {
  type:
    'block-start',

  index:
    currentIndex,

  blockType:
    'text',
}
```

增量：

```ts
yield {
  type:
    'text-delta',

  index:
    currentIndex,

  text:
    delta,
}
```

结束：

```ts
yield {
  type:
    'block-end',

  index:
    currentIndex,

  block: {
    type:
      'text',

    text:
      completeText,
  },
}
```

---

# 48. Gemini Function Call → DSH

Gemini：

```ts
{
  functionCall: {
    name: 'bash',
    args: {
      command: 'ls'
    }
  }
}
```

转换：

```ts
yield {
  type:
    'block-start',

  index,

  blockType:
    'tool-call',
}
```

然后：

```ts
yield {
  type:
    'tool-call-delta',

  index,

  id:
    CallId(callId),

  name:
    functionCall.name,

  argumentsDelta:
    JSON.stringify(
      functionCall.args ?? {}
    ),
}
```

结束：

```ts
yield {
  type:
    'block-end',

  index,

  block: {
    type:
      'tool-call',

    id:
      CallId(callId),

    name:
      functionCall.name,

    arguments:
      JSON.stringify(
        functionCall.args ?? {}
      ),
  },
}
```

每个 tool call 必须生成稳定唯一 call ID。

可以：

```ts
randomUUID()
```

---

# 49. Usage

Gemini：

```text
usageMetadata.promptTokenCount
usageMetadata.candidatesTokenCount
```

映射：

```ts
yield {
  type: 'usage',

  usage: {
    inputTokens:
      promptTokenCount ?? 0,

    outputTokens:
      candidatesTokenCount ?? 0,
  },
}
```

必须在：

```text
finish
```

之前。

---

# 50. Finish

如果本轮出现 function call：

```ts
yield {
  type: 'finish',

  reason: {
    kind:
      'tool-calls',
  },
}
```

否则：

```ts
yield {
  type: 'finish',

  reason: {
    kind:
      'stop',
  },
}
```

`finish` 必须是整个 generator 最后一个 chunk。

---

# 51. AbortSignal

所有 Gemini 请求必须传：

```ts
options.signal
```

用户取消后：

```text
HTTP stream
SSE parser
Adapter
```

都应尽快停止。

不要吞掉 abort。

---

# 52. Gemini HTTP Retry

V0.1：

```text
streamGenerateContent
```

不要在 Adapter 内自动 replay 已经开始输出的 stream。

请求在收到任何输出之前可做非常有限 retry。

建议：

```text
429
500-599
```

最多：

```text
2 次
```

但如果实现复杂，V0.1 可以：

```text
stream retry = false
```

交给 DSH 上层 retry。

认证错误：

```text
401
```

让 `google-auth-library` 先处理 refresh。

仍失败：

```text
GEMINI_AUTH_REQUIRED
```

---

# 53. Error Codes

统一使用稳定错误码。

Codex：

```text
CODEX_AUTH_REQUIRED
CODEX_OAUTH_STATE_MISMATCH
CODEX_OAUTH_FAILED
CODEX_TOKEN_EXCHANGE_FAILED
CODEX_REFRESH_FAILED
CODEX_ACCOUNT_ID_MISSING
```

Gemini：

```text
GEMINI_AUTH_REQUIRED
GEMINI_OAUTH_STATE_MISMATCH
GEMINI_OAUTH_FAILED
GEMINI_REFRESH_TOKEN_MISSING
GEMINI_PROJECT_REQUIRED
GEMINI_INVALID_PROJECT_ID
GEMINI_VALIDATION_REQUIRED
GEMINI_ACCOUNT_NOT_ELIGIBLE
GEMINI_NO_ALLOWED_TIER
GEMINI_ONBOARDING_FAILED
GEMINI_ONBOARDING_TIMEOUT
GEMINI_HTTP_ERROR
GEMINI_STREAM_ERROR
```

模型层：

```ts
throw new LlmError(
  message,
  code
)
```

---

# 54. Control Server

插件启动：

```text
127.0.0.1:1456
```

只用于本地控制。

接口：

```text
GET  /status

POST /auth/codex/start
POST /auth/codex/logout

POST /auth/gemini/start
POST /auth/gemini/logout
```

---

# 55. GET /status

返回：

```json
{
  "codex": {
    "authenticated": true
  },
  "gemini": {
    "authenticated": false
  }
}
```

禁止返回：

```text
access token
refresh token
id token
```

---

# 56. POST /auth/codex/start

返回：

```json
{
  "authUrl":
    "https://auth.openai.com/..."
}
```

---

# 57. POST /auth/gemini/start

返回：

```json
{
  "authUrl":
    "https://accounts.google.com/..."
}
```

---

# 58. Logout

Codex：

```text
clearCodexCredential()
ctx.credentials.unset(
  CODEX_TOKEN_REF
)
```

Gemini：

```text
clearGeminiCredential()
清除内存 OAuth2Client
清除 project cache
```

V0.1 不要求调用 provider token revoke endpoint。

---

# 59. Control Server 安全

只监听：

```text
127.0.0.1
```

不要：

```text
0.0.0.0
```

需要基本 Origin 检查。

允许：

```text
localhost
127.0.0.1
::1
```

禁止远程网页直接调用本地 control server。

如果使用 CSRF token：

```text
/start 生成
client 保存
POST 写操作要求
```

更好。

---

# 60. client.tsx

`client.tsx` 导出 `inject = ['slots', 'locale']` 和 `apply(ctx)`，通过 `settings.section` 注册 OAuth 面板。页面文案由 `client-locales.ts` 提供中文和英文，按钮与状态分别使用 DSH `Button` 和 `Pill`。页面只使用少量 `React.CSSProperties` 做布局，不附带 CSS 文件。构建时将其编译为浏览器安全的 `window.__ModuleLoader__.load({ id, factory })` 客户端模块；`exports["./client"]` 指向该产物，DSH Web 会按 `dsh.client` 声明加载它。

Settings UI：

```text
OAuth 登录 / OAuth Providers

Codex
已连接 / Connected
[ 退出登录 / Log out ]

Gemini CLI
未连接 / Not connected
[ 使用 Google 登录 / Login with Google ]
```

或者：

```text
Codex
[ Login with ChatGPT ]

Gemini CLI
[ Login with Google ]
```

只有：

```text
Login
Logout
Status
```

禁止增加：

```text
Token 展示
API Key 输入
Endpoint 输入
多账号
Quota
Web Search
Image
高级设置
```

---

# 61. 浏览器打开方式

必须：

```ts
window.open(
  authUrl,
  '_blank',
)
```

禁止后端：

```text
spawn
exec
open package
child_process
```

---

# 62. index.ts

职责仅限：

```text
初始化 storage
初始化 Codex OAuth service
初始化 Gemini OAuth service
注册 GeminiCliAdapter
启动 control server
生命周期 dispose
```

伪代码：

```ts
export const inject = [
  'credentials',
  'llm',
  'settings',
]

export function apply(
  ctx: Context,
  config: Config,
) {
  const codex =
    createCodexService(
      ctx,
      config,
    )

  const gemini =
    createGeminiService(
      ctx,
      config,
    )

  const geminiAdapter = new GeminiCliAdapter(gemini)
  const syncGeminiRoute = createGeminiRouteSync(ctx, geminiAdapter)
  // initialize() 的认证状态回调负责首次注册、route replace 和撤销。

  // start control server

  // during startup:
  // if codex credential exists,
  // ensure token valid and set
  // DSH_OPENAI_CODEX_TOKEN
}
```

---

# 63. Plugin Config

只提供：

```ts
interface Config {
  dshHome?: string
  controlPort?: number
  codexRedirectPort?: number
}
```

默认：

```text
controlPort = 1456
codexRedirectPort = 1455
```

Gemini callback port：

```text
动态
```

不要让用户配置几十个 OAuth 参数。

---

# 64. Startup

插件启动时：

```text
1. load credential document
2. 如果有 Codex credential：
   - getCodexAccessToken()
   - 如果可刷新成功：
       ctx.credentials.set()
   - 如果 permanent auth failure：
       清 credential
3. 如果有 Gemini credential：
   - 创建 OAuth2Client
   - setCredentials()
   - 不必立即发模型请求
4. 注册 Gemini Adapter
5. 启动 control server
```

---

# 65. Codex Refresh Timer

Codex service 在启动或登录后按 `expiresAt - 60 秒` 安排一次性刷新：

```text
getCodexAccessToken()
        ↓
ctx.credentials.set(DSH_OPENAI_CODEX_TOKEN)
        ↓
expiresAt - 60 秒
        ↓
再次刷新并保存 credential
```

正常情况下不会在 token endpoint 未到期时重复请求；临时刷新失败会延迟重试，永久失效则清除 credential 并要求重新登录。

---

# 66. Gemini Refresh Timer

禁止写 Gemini refresh timer。

交给：

```text
google-auth-library
```

按需刷新。

---

# 67. 日志

可以：

```text
Codex login started
Codex login succeeded
Codex token refreshed
Gemini login started
Gemini login succeeded
Gemini Code Assist setup completed
```

禁止：

```text
access_token=...
refresh_token=...
id_token=...
Authorization: Bearer ...
完整 OAuth callback URL
完整用户 prompt
```

---

# 68. 测试要求

至少实现以下测试。

## storage

```text
credential save/load
refresh merge 保留旧 refresh token
clear credential
invalid JSON
```

## Codex

```text
PKCE challenge 正确
state mismatch
authorization code exchange mock
refresh merge
accountId decode
expired token refresh
permanent refresh failure 清 credential
```

## Gemini

```text
state mismatch
getToken credential 保存
refresh token 不被覆盖
loadCodeAssist currentTier
loadCodeAssist project required
onboarding
onboarding operation polling
SSE 单 event
SSE 多 data line
text → StreamChunk
functionCall → StreamChunk
usage 在 finish 前
finish 最后
abort
```

---

# 69. Mock 原则

单元测试禁止请求真实：

```text
auth.openai.com
accounts.google.com
cloudcode-pa.googleapis.com
```

必须 mock：

```text
fetch
OAuth2Client
client.request
```

真实 OAuth 只做手工集成测试。

---

# 70. 手工验收：Codex

安装插件。

未登录：

```text
DSH UI 显示 Codex 未连接（Not connected）
```

点击：

```text
Login with ChatGPT
```

浏览器打开：

```text
auth.openai.com
```

登录成功后：

```text
callback 成功
credential 文件写入
/status codex.authenticated=true
```

然后：

```text
DSH model picker
```

可以看到：

```text
openai-codex
```

相关模型。

发送：

```text
Hello
```

必须成功回复。

过程中：

```text
无 codex CLI 进程
无 spawn
```

---

# 71. 手工验收：Codex Refresh

人为使：

```text
expiresAt < now
```

再次使用 Codex。

预期：

```text
自动 refresh
→ 保存新 access token
→ DSH credentials 更新
→ 请求成功
```

无需：

```text
重启 DSH
```

---

# 72. 手工验收：Gemini

点击：

```text
Login with Google
```

浏览器打开 Google OAuth。

成功 callback：

```text
credential 保存
```

然后：

```text
loadCodeAssist
```

成功。

需要 onboarding：

```text
自动 onboard
```

最终：

```text
/status
gemini.authenticated=true
```

---

# 73. 手工验收：Gemini Chat

选择：

```text
provider =
gemini-cli-oauth
```

发送：

```text
Hello
```

请求必须：

```text
直接到
cloudcode-pa.googleapis.com
```

不能：

```text
spawn gemini
```

结果：

```text
Gemini SSE
→ DSH StreamChunk
→ UI 正常显示
```

---

# 74. 手工验收：Gemini Tool Call

提供一个简单 DSH tool：

```text
get_current_time
```

要求模型调用。

必须完成：

```text
DSH tool schema
→ Gemini functionDeclarations
→ Gemini functionCall
→ DSH tool-call StreamChunk
→ DSH 执行 tool
→ tool result 回传
→ Gemini 继续生成
```

---

# 75. Definition of Done

V0.1 只有满足全部条件才能完成：

```text
[ ] 插件可通过 DSH bundle 安装

[ ] 无 child_process

[ ] 无 spawn

[ ] 无 exec

[ ] 无 Codex CLI dependency

[ ] 无 Gemini CLI dependency

[ ] Codex OAuth 浏览器登录成功

[ ] Codex credential 可持久化

[ ] Codex refresh 工作

[ ] Codex access token 写入 DSH Credentials

[ ] DSH 内置 openai-codex 可以聊天

[ ] Gemini Google OAuth 成功

[ ] Gemini credential 可持久化

[ ] Gemini refresh 由 google-auth-library 管理

[ ] loadCodeAssist 成功

[ ] 新用户 onboarding 可处理

[ ] streamGenerateContent 成功

[ ] Gemini text stream 正常

[ ] Gemini tool call 正常

[ ] Gemini usage 正常

[ ] DSH finish chunk 顺序正确

[ ] AbortSignal 正常

[ ] Logout 正常

[ ] /status 不泄露 credential

[ ] 日志不泄露 token
```

---

# 76. 实现顺序

Agent 必须按顺序开发。

## Phase 1：插件骨架

实现：

```text
package.json
tsconfig.json
cordis.patch.yml
index.ts
```

验收：

```text
DSH 可以加载插件
```

---

## Phase 2：storage

实现：

```text
oauth-bridge.json
atomic write
load/save/clear
```

测试完成再继续。

---

## Phase 3：Codex OAuth

实现：

```text
PKCE
state
callback server
token exchange
JWT accountId
storage
```

验收：

```text
登录成功后文件存在
```

---

## Phase 4：DSH Codex Credentials

实现：

```text
credentialRef(
  DSH_OPENAI_CODEX_TOKEN
)
```

以及：

```text
ctx.credentials.set()
```

验收：

```text
DSH openai-codex
可以聊天
```

不要在这一阶段写 Codex Adapter。

---

## Phase 5：Codex Refresh

实现并测试。

---

## Phase 6：Gemini OAuth

实现：

```text
OAuth2Client
dynamic loopback port
generateAuthUrl
getToken
storage
```

---

## Phase 7：Gemini Code Assist Setup

实现：

```text
loadCodeAssist
onboardUser
operation polling
projectId
```

---

## Phase 8：Gemini Adapter 基础文本

只实现：

```text
user text
assistant text
system prompt
streamGenerateContent
text StreamChunk
usage
finish
```

先让：

```text
Hello
```

能完整对话。

---

## Phase 9：Gemini Tool Calls

补：

```text
tools
functionCall
functionResponse
tool-call StreamChunk
```

---

## Phase 10：UI

最后实现：

```text
status
login
logout
window.open
```

不要先做 UI。

---

# 77. 关键约束再次强调

Agent 不得自行把项目重构成：

```text
ProviderRegistry
BaseProvider
AbstractOAuthProvider
OAuthProviderFactory
CredentialRepository
AuthManager
TransportManager
```

Codex 与 Gemini 的实现差异足够大。

正确做法：

```text
codex.ts
gemini.ts
```

分别实现。

共享的只有：

```text
storage.ts
index.ts
```

---

# 78. 上游协议风险

Codex：

```text
auth.openai.com OAuth
+
DSH/pi-ai openai-codex
```

属于可能变化的产品协议。

Gemini：

```text
cloudcode-pa.googleapis.com/v1internal
```

属于 Gemini Code Assist 内部接口。

要求：

```text
所有 endpoint
所有 client id
所有 protocol constant
集中定义
```

方便以后升级。

如果上游明确拒绝第三方客户端：

```text
返回 unsupported / auth error
```

不要尝试：

```text
伪造客户端
绕过限制
绕过风控
绕过服务条款
```

---

# 79. 最终架构图

```text
                           DSH Web UI
                               │
                    Login / Logout / Status
                               │
                               ▼
                     127.0.0.1:1456
                               │
                     dsh-oauth-bridge
                               │
              ┌────────────────┴─────────────────┐
              │                                  │
              │                                  │
           Codex                              Gemini
              │                                  │
          PKCE OAuth                       Google OAuth
              │                                  │
              ▼                                  ▼
      auth.openai.com                   accounts.google.com
              │                                  │
              ▼                                  ▼
      Codex Credential                   Gemini Credential
              │                                  │
              ▼                                  ▼
  ctx.credentials.set()                  OAuth2Client
              │                                  │
              ▼                                  ▼
     DSH llm-pi-ai                  loadCodeAssist/onboard
              │                                  │
              ▼                                  ▼
       openai-codex                 streamGenerateContent
              │                                  │
              ▼                                  ▼
      Codex Responses                    Gemini SSE
              │                                  │
              │                                  ▼
              │                         GeminiCliAdapter
              │                                  │
              └─────────────────┬────────────────┘
                                ▼
                           DSH Stream
                                │
                                ▼
                           DSH Agent Loop
```

---

# 80. Agent 最终交付物

必须提交：

```text
package.json
tsconfig.json
cordis.patch.yml

src/index.ts
src/storage.ts
src/codex.ts
src/gemini.ts
src/client.tsx
src/client-locales.ts

tests/storage.test.ts
tests/codex.test.ts
tests/gemini.test.ts

README.md
```

README 至少写：

```text
安装
Codex 登录
Gemini 登录
支持范围
已知限制
安全说明
```

---

# 81. Commit 规范

提交 commit 时使用中文 Conventional Commit 风格。

示例：

```text
feat: 实现 Codex OAuth 登录与令牌刷新

feat: 接入 Gemini Code Assist OAuth 模型调用

fix: 保留 OAuth 刷新响应缺失的 refresh token

test: 补充 Gemini SSE 与工具调用测试

docs: 补充 OAuth Bridge 安装与使用说明
```

---

# 82. 第一优先级

如果 Agent 遇到不确定问题，优先保证：

```text
1. 不 spawn CLI
2. Codex 只负责 OAuth，不重复实现模型 Adapter
3. Gemini 使用 google-auth-library
4. Gemini 请求 Code Assist，不走 Gemini API Key
5. Token 不泄露
6. DSH StreamChunk 协议正确
7. 实现尽可能简单
```

不得为了所谓“通用性”增加架构复杂度。
