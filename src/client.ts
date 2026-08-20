export interface OAuthStatus {
  codex: { authenticated: boolean }
  gemini: { authenticated: boolean }
}

export interface OAuthBridgeClient {
  status(): Promise<OAuthStatus>
  login(provider: 'codex' | 'gemini'): Promise<void>
  logout(provider: 'codex' | 'gemini'): Promise<void>
}

export const inject = ['slots'] as const

interface ReactRuntime {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
}

interface ClientContext {
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
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
      const popup = window.open('about:blank', '_blank')
      if (!popup) throw new Error('OAuth popup was blocked')
      try {
        const result = await call(`/auth/${provider}/start`, 'POST')
        const authUrl = result.authUrl
        if (typeof authUrl !== 'string') throw new Error('OAuth control response did not include authUrl')
        popup.location.href = authUrl
      } catch (error) {
        popup.close()
        throw error
      }
    },
    async logout(provider) {
      await call(`/auth/${provider}/logout`, 'POST')
    },
  }
}

/** Poll the loopback status endpoint until the browser callback has persisted credentials. */
async function waitForAuthentication(provider: 'codex' | 'gemini', client: OAuthBridgeClient, timeout = 60_000): Promise<OAuthStatus> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = await client.status()
    if (status[provider].authenticated) return status
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(`${provider} OAuth callback was not completed before the status polling timeout`)
}

/** Resolve React from the DSH client module table only when the settings component renders. */
function reactRuntime(): ReactRuntime {
  if (typeof require !== 'function') throw new Error('DSH OAuth client requires the DSH React runtime')
  return require('react') as ReactRuntime
}

/** Render the OAuth provider controls used by the DSH settings slot. */
function OAuthProviderPanel(): unknown {
  const React = reactRuntime()
  const client = createOAuthBridgeClient()
  const [status, setStatus] = React.useState<OAuthStatus | undefined>(undefined)
  const [busy, setBusy] = React.useState<'codex' | 'gemini' | undefined>(undefined)
  const [error, setError] = React.useState<string | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await client.status())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'OAuth control server is unavailable')
    }
  }

  React.useEffect(() => {
    let active = true
    const poll = async (): Promise<void> => {
      try {
        const next = await client.status()
        if (active) {
          setStatus(next)
          setError(undefined)
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'OAuth control server is unavailable')
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const handleAction = async (provider: 'codex' | 'gemini'): Promise<void> => {
    setBusy(provider)
    try {
      if (status?.[provider].authenticated) await client.logout(provider)
      else {
        await client.login(provider)
        await waitForAuthentication(provider, client)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'OAuth operation failed')
    } finally {
      setBusy(undefined)
    }
  }

  const row = (provider: 'codex' | 'gemini', title: string, loginLabel: string): unknown => {
    const authenticated = status?.[provider].authenticated === true
    return React.createElement('div', { key: provider, style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '10px' } },
      React.createElement('strong', null, title),
      React.createElement('span', { style: { flex: 1 } }, authenticated ? '● Connected' : '○ Not connected'),
      React.createElement('button', { type: 'button', disabled: busy !== undefined, onClick: () => void handleAction(provider) }, busy === provider ? 'Working…' : authenticated ? 'Logout' : loginLabel),
    )
  }

  return React.createElement('section', { style: { padding: '16px', border: '1px solid var(--border, #d7dce2)', borderRadius: '8px', marginBottom: '16px' } },
    React.createElement('h2', { style: { margin: 0 } }, 'OAuth Providers'),
    row('codex', 'Codex', 'Login with ChatGPT'),
    row('gemini', 'Gemini CLI', 'Login with Google'),
    error === undefined ? null : React.createElement('p', { role: 'alert', style: { color: '#b42318', marginBottom: 0 } }, error),
  )
}

/**
 * Register the OAuth panel in the DSH Web settings surface.
 *
 * @param ctx - DSH client context providing the settings slot registry.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-oauth', order: 5, label: 'OAuth Providers' }, OAuthProviderPanel))
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
      else {
        await client.login(provider)
        await waitForAuthentication(provider, client)
      }
      await renderOAuthProviders(container, client)
    })
    row.append(title, state, button)
    container.append(row)
  }
}
