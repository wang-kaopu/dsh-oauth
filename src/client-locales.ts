export const en = {
  nav: 'OAuth Providers',

  title: 'OAuth Providers',
  intro: 'Connect subscription accounts used by DSH models.',

  codexName: 'Codex',
  codexDescription:
    'Use your ChatGPT subscription for Codex models.',

  geminiName: 'Gemini CLI',
  geminiDescription:
    'Use Google OAuth with Gemini Code Assist.',

  connected: 'Connected',
  notConnected: 'Not connected',

  loginChatGPT: 'Login with ChatGPT',
  loginGoogle: 'Login with Google',
  logout: 'Log out',
  working: 'Working…',

  unavailable:
    'OAuth control server is unavailable.',

  operationFailed:
    'OAuth operation failed.',
} as const

export type OAuthLocaleKey =
  keyof typeof en

export const zh:
  Record<OAuthLocaleKey, string> = {
  nav: 'OAuth 登录',

  title: 'OAuth 登录',
  intro: '连接 DSH 模型使用的订阅账号。',

  codexName: 'Codex',
  codexDescription:
    '使用 ChatGPT 订阅访问 Codex 模型。',

  geminiName: 'Gemini CLI',
  geminiDescription:
    '使用 Google OAuth 连接 Gemini Code Assist。',

  connected: '已连接',
  notConnected: '未连接',

  loginChatGPT: '使用 ChatGPT 登录',
  loginGoogle: '使用 Google 登录',
  logout: '退出登录',
  working: '处理中…',

  unavailable:
    'OAuth 控制服务不可用。',

  operationFailed:
    'OAuth 操作失败。',
}
