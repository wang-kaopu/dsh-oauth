import {
  useEffect,
  useState,
  type CSSProperties,
} from 'react'

import {
  Button,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  ClientContext,
} from '@deepseek-ai/dsh-client-runtime/client'

import type {
  PropsLocale,
} from '@deepseek-ai/dsh-client-ui-slots'

import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

import {
  en,
  zh,
  type OAuthLocaleKey,
} from './client-locales.js'

const NS = 'settings.oauth'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oauth': OAuthLocaleKey
  }
}

export interface OAuthStatus {
  codex: { authenticated: boolean }
  gemini: { authenticated: boolean }
}

export interface OAuthBridgeClient {
  status(): Promise<OAuthStatus>
  login(provider: 'codex' | 'gemini'): Promise<void>
  logout(provider: 'codex' | 'gemini'): Promise<void>
}

export const inject = ['slots', 'locale'] as const

const styles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: 760,
    color: 'var(--dsw-alias-label-primary)',
  },

  heading: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    lineHeight: 1.4,
  },

  intro: {
    margin: '4px 0 12px',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary)',
  },

  providers: {
    display: 'flex',
    flexDirection: 'column',
  },

  provider: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    minHeight: 64,
    padding: '14px 0',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },

  providerInfo: {
    flex: 1,
    minWidth: 0,
  },

  providerName: {
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.5,
  },

  providerDescription: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary)',
  },

  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },

  error: {
    margin: '12px 0 0',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-error)',
  },
} satisfies Record<string, CSSProperties>

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

/**
 * Poll the loopback status endpoint until the browser callback has persisted credentials.
 *
 * @param provider - OAuth provider whose callback is being awaited.
 * @param client - loopback control client.
 * @param timeout - maximum wait duration in milliseconds.
 * @returns the status containing the authenticated provider.
 */
async function waitForAuthentication(provider: 'codex' | 'gemini', client: OAuthBridgeClient, timeout = 60_000): Promise<OAuthStatus> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = await client.status()
    if (status[provider].authenticated) return status
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(`${provider} OAuth callback was not completed before the status polling timeout`)
}

interface ProviderRowProps {
  name: string
  description: string
  authenticated: boolean
  busy: boolean
  loginLabel: string
  connectedLabel: string
  notConnectedLabel: string
  logoutLabel: string
  workingLabel: string
  onAction(): void
}

/** Render one provider's localized status and DSH-native action controls. */
function ProviderRow(props: ProviderRowProps) {
  return (
    <div style={styles.provider}>
      <div style={styles.providerInfo}>
        <div style={styles.providerName}>
          {props.name}
        </div>

        <div style={styles.providerDescription}>
          {props.description}
        </div>
      </div>

      <div style={styles.actions}>
        <Pill active={props.authenticated}>
          {props.authenticated
            ? props.connectedLabel
            : props.notConnectedLabel}
        </Pill>

        <Button
          size="sm"
          variant={props.authenticated ? 'outline' : 'primary'}
          disabled={props.busy}
          onClick={props.onAction}
        >
          {props.busy
            ? props.workingLabel
            : props.authenticated
              ? props.logoutLabel
              : props.loginLabel}
        </Button>
      </div>
    </div>
  )
}

type OAuthProviderPanelProps = PropsLocale<'settings.oauth'>

/** Render the OAuth provider controls used by the DSH settings slot. */
function OAuthProviderPanel({ t }: OAuthProviderPanelProps) {
  const client = createOAuthBridgeClient()
  const [status, setStatus] = useState<OAuthStatus | undefined>(undefined)
  const [busy, setBusy] = useState<'codex' | 'gemini' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await client.status())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unavailable'))
    }
  }

  useEffect(() => {
    let active = true
    const poll = async (): Promise<void> => {
      try {
        const next = await client.status()
        if (active) {
          setStatus(next)
          setError(undefined)
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : t('unavailable'))
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
      setError(cause instanceof Error ? cause.message : t('operationFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>
        {t('title')}
      </h2>

      <p style={styles.intro}>
        {t('intro')}
      </p>

      <div style={styles.providers}>
        <ProviderRow
          name={t('codexName')}
          description={t('codexDescription')}
          authenticated={status?.codex.authenticated === true}
          busy={busy === 'codex'}
          loginLabel={t('loginChatGPT')}
          connectedLabel={t('connected')}
          notConnectedLabel={t('notConnected')}
          logoutLabel={t('logout')}
          workingLabel={t('working')}
          onAction={() => void handleAction('codex')}
        />

        <ProviderRow
          name={t('geminiName')}
          description={t('geminiDescription')}
          authenticated={status?.gemini.authenticated === true}
          busy={busy === 'gemini'}
          loginLabel={t('loginGoogle')}
          connectedLabel={t('connected')}
          notConnectedLabel={t('notConnected')}
          logoutLabel={t('logout')}
          workingLabel={t('working')}
          onAction={() => void handleAction('gemini')}
        />
      </div>

      {error !== undefined
        ? (
          <p role="alert" style={styles.error}>
            {error}
          </p>
        )
        : null}
    </section>
  )
}

/**
 * Register the OAuth panel in the DSH Web settings surface.
 *
 * @param ctx - DSH client context providing the settings and locale services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'dsh-oauth: settings locale',
  )

  ctx.slots.inject(
    'settings.section',
    () => ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-oauth',
        order: 5,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
      },
      OAuthProviderPanel,
    ),
  )
}
