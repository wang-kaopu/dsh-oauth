export interface OAuthStatus {
  codex: { authenticated: boolean }
  gemini: { authenticated: boolean }
}

export interface OAuthBridgeClient {
  status(): Promise<OAuthStatus>
  login(provider: 'codex' | 'gemini'): Promise<void>
  logout(provider: 'codex' | 'gemini'): Promise<void>
}

/**
 * Create the browser-side client for the loopback OAuth control server.
 *
 * @param baseUrl - loopback control server URL.
 * @returns status, login, and logout operations.
 */
export function createOAuthBridgeClient(baseUrl = 'http://127.0.0.1:1456'): OAuthBridgeClient {
  async function call(path: string, method: 'GET' | 'POST'): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}${path}`, { method })
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `OAuth control request failed (${response.status})`)
    return body
  }

  return {
    async status() {
      return await call('/status', 'GET') as unknown as OAuthStatus
    },
    async login(provider) {
      const result = await call(`/auth/${provider}/start`, 'POST')
      const authUrl = result.authUrl
      if (typeof authUrl !== 'string') throw new Error('OAuth control response did not include authUrl')
      window.open(authUrl, '_blank')
    },
    async logout(provider) {
      await call(`/auth/${provider}/logout`, 'POST')
    },
  }
}

/**
 * Render the intentionally small OAuth provider status panel.
 *
 * @param container - DOM node that receives the panel.
 * @param client - loopback control client.
 */
export async function renderOAuthProviders(container: HTMLElement, client = createOAuthBridgeClient()): Promise<void> {
  const status = await client.status()
  container.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = 'OAuth Providers'
  container.append(heading)
  for (const provider of ['codex', 'gemini'] as const) {
    const row = document.createElement('section')
    const title = document.createElement('strong')
    title.textContent = provider === 'codex' ? 'Codex' : 'Gemini CLI'
    const state = document.createElement('span')
    state.textContent = status[provider].authenticated ? ' ● Connected' : ' ○ Not connected'
    const button = document.createElement('button')
    button.textContent = status[provider].authenticated ? 'Logout' : provider === 'codex' ? 'Login with ChatGPT' : 'Login with Google'
    button.addEventListener('click', async () => {
      if (status[provider].authenticated) await client.logout(provider)
      else await client.login(provider)
      await renderOAuthProviders(container, client)
    })
    row.append(title, state, button)
    container.append(row)
  }
}
