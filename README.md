# DSH OAuth Bridge

## 简介

DSH OAuth Bridge 是一个 DeepSeek Harness 插件，通过浏览器 OAuth 接入 ChatGPT Codex 订阅和 Gemini Code Assist，为 DSH 提供 Codex 与 Gemini 模型访问能力。

## 安装方法

直接将插件加入 DSH 的 `web` profile：

```sh
dsh plugin --profile web add @wang-kaopu/dsh-oauth
```

## 开发

项目要求 Node.js `22.19.0+` 或 `24.11.0+`。

安装依赖：

```sh
npm install
```

构建、类型检查和运行测试：

```sh
npm run build
npm run check
npm test
```

仅构建浏览器端 bundle：

```sh
npm run bundle
```

监听浏览器端代码变化并自动构建：

```sh
npm run watch:client
```

## 注意事项

- 使用 Gemini 前，需要通过环境变量提供 Google installed-app client 凭据：

  ```sh
  export GEMINI_CLIENT_ID="..."
  export GEMINI_CLIENT_SECRET="..."
  ```

- Gemini 非 FREE tier 需要设置 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID`。
- 插件当前只支持单账号；Gemini callback 端口由操作系统动态分配。
- Gemini 模型目录采用静态配置，默认提供 `gemini-2.5-pro` 和 `gemini-2.5-flash`，不做远程发现。
- 暂不支持 reasoning effort、额度、代理、Web Search、图像生成和 token revoke endpoint。
- OAuth 令牌保存在 `$DSH_HOME/oauth-bridge.json`，文件权限为 `0600`。本地 control server 只监听 `127.0.0.1:1456`。
