import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  clearCodexCredential,
  loadCodexCredential,
  saveCodexCredential,
  type CodexCredential,
} from './storage.js'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_ISSUER = 'https://auth.openai.com'
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`
export const CODEX_REDIRECT_PORT = 1455
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_REDIRECT_PORT}/auth/callback`
export const CODEX_TOKEN_REF = credentialRef('DSH_OPENAI_CODEX_TOKEN')

const CODEX_SCOPE = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke',
].join(' ')

export interface CodexServiceConfig {
  dshHome?: string
  codexRedirectPort?: number
  onAuthStateChange?: (authenticated: boolean) => void | Promise<void>
}

interface PendingLogin {
  server: Server
  verifier: string
  state: string
  redirectUri: string
}

interface CodexTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  error?: string
}

function errorWithCode(message: string, code: string, options?: { cause?: unknown }): LlmError {
  return new LlmError(message, code, options)
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function readAccountId(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) return undefined
  const auth = claims['https://api.openai.com/auth']
  if (typeof auth === 'object' && auth !== null) {
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    if (typeof accountId === 'string' && accountId.length > 0) return accountId
  }
  const direct = claims.chatgpt_account_id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const organizations = claims.organizations
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = organizations[0]
    if (typeof first === 'string' && first.length > 0) return first
    if (typeof first === 'object' && first !== null) {
      const id = (first as Record<string, unknown>).id
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  return undefined
}

function accountIdFromTokens(accessToken: string, idToken?: string): string | undefined {
  return readAccountId(decodeJwtPayload(accessToken)) ?? readAccountId(idToken === undefined ? undefined : decodeJwtPayload(idToken))
}

function responseHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DSH OAuth Bridge</title></head><body><p>${message}</p><p>You can close this window.</p></body></html>`
}

function sendResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(responseHtml(message))
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Codex callback server did not expose a bound port')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function readTokenResponse(response: Response, failureCode: string): Promise<CodexTokenResponse> {
  let body: CodexTokenResponse
  try {
    body = await response.json() as CodexTokenResponse
  } catch (error) {
    throw errorWithCode('Codex token endpoint returned malformed JSON', failureCode, { cause: error })
  }
  if (typeof body !== 'object' || body === null) throw errorWithCode('Codex token endpoint returned an invalid response', failureCode)
  if (!response.ok) {
    throw errorWithCode(`Codex token endpoint rejected the request (${response.status})`, failureCode)
  }
  return body
}

async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<CodexCredential> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const tokens = await readTokenResponse(response, 'CODEX_TOKEN_EXCHANGE_FAILED')
  if (!tokens.access_token || !tokens.refresh_token) throw errorWithCode('Codex token response did not include required tokens', 'CODEX_TOKEN_EXCHANGE_FAILED')
  const accountId = accountIdFromTokens(tokens.access_token, tokens.id_token)
  if (!accountId) throw errorWithCode('Codex token did not contain a ChatGPT account ID', 'CODEX_ACCOUNT_ID_MISSING')
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    ...(tokens.id_token === undefined ? {} : { idToken: tokens.id_token }),
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
  }
}

async function refreshCode(credential: CodexCredential): Promise<CodexCredential> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: credential.refreshToken,
  })
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  let tokens: CodexTokenResponse
  try {
    tokens = await response.json() as CodexTokenResponse
  } catch (error) {
    throw errorWithCode('Codex refresh endpoint returned malformed JSON', 'CODEX_REFRESH_FAILED', { cause: error })
  }
  if (typeof tokens !== 'object' || tokens === null) throw errorWithCode('Codex refresh endpoint returned an invalid response', 'CODEX_REFRESH_FAILED')
  if (!response.ok) {
    const permanent = ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(tokens.error ?? '')
    throw errorWithCode('Codex access token refresh failed', permanent ? 'CODEX_AUTH_REQUIRED' : 'CODEX_REFRESH_FAILED')
  }
  if (!tokens.access_token) throw errorWithCode('Codex refresh response did not include an access token', 'CODEX_REFRESH_FAILED')
  return {
    ...credential,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? credential.refreshToken,
    ...(tokens.id_token === undefined ? {} : { idToken: tokens.id_token }),
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }
}

/**
 * Create the Codex OAuth bridge for one DSH context.
 *
 * @param ctx - DSH context owning credentials and logging.
 * @param config - storage and callback-port configuration.
 * @returns the Codex login, refresh, status, and cleanup operations.
 */
export function createCodexService(ctx: Context, config: CodexServiceConfig = {}) {
  const redirectPort = config.codexRedirectPort ?? CODEX_REDIRECT_PORT
  let pending: PendingLogin | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let credentialMutation: Promise<void> = Promise.resolve()
  let lastAuthState: boolean | undefined
  let authStateRetryTimer: ReturnType<typeof setTimeout> | undefined

  /** Cancel the one-shot retry for a failed route synchronization. */
  function clearAuthStateRetry(): void {
    if (authStateRetryTimer === undefined) return
    clearTimeout(authStateRetryTimer)
    authStateRetryTimer = undefined
  }

  /** Retry one failed route synchronization without changing the completed OAuth transaction. */
  function scheduleAuthStateRetry(authenticated: boolean): void {
    clearAuthStateRetry()
    authStateRetryTimer = setTimeout(() => {
      authStateRetryTimer = undefined
      if (lastAuthState !== authenticated) return
      void (async () => {
        try {
          await config.onAuthStateChange?.(authenticated)
        } catch (error) {
          ctx.logger.warn(`OAuth route sync retry failed (${error instanceof Error ? error.message : String(error)})`)
        }
      })()
    }, 1_000)
    authStateRetryTimer.unref?.()
  }

  /** Publish an authentication transition without allowing route failures to fail OAuth. */
  async function publishAuthState(authenticated: boolean): Promise<void> {
    if (authenticated === lastAuthState) return
    lastAuthState = authenticated
    clearAuthStateRetry()
    try {
      await config.onAuthStateChange?.(authenticated)
    } catch (error) {
      ctx.logger.warn(`OAuth route sync failed (${error instanceof Error ? error.message : String(error)})`)
      scheduleAuthStateRetry(authenticated)
    }
  }

  async function setDshCredential(accessToken: string): Promise<void> {
    await ctx.credentials.set(CODEX_TOKEN_REF, accessToken)
  }

  /** Cancel the pending refresh so logout and disposal cannot mutate credentials later. */
  function clearRefreshTimer(): void {
    if (refreshTimer === undefined) return
    clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  /** Schedule one refresh at the safe boundary before the access token expires. */
  function scheduleRefresh(expiresAt: number, delayOverride?: number): void {
    clearRefreshTimer()
    const delay = delayOverride ?? Math.max(0, expiresAt - Date.now() - 60_000)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void getCodexAccessToken().catch(error => {
        const code = (error as { code?: string }).code
        if (code === 'CODEX_AUTH_REQUIRED') {
          ctx.logger.warn('Codex authentication is required')
          return
        }
        ctx.logger.warn(`Codex scheduled token refresh failed (${code ?? 'unknown'})`)
        void scheduleRetryIfAuthenticated().catch(retryError => {
          const retryCode = (retryError as { code?: string }).code
          ctx.logger.warn(`Codex retry scheduling failed (${retryCode ?? 'unknown'})`)
        })
      })
    }, Math.max(0, delay))
    refreshTimer.unref?.()
  }

  /** Serialize all credential mutations so logout cannot be overtaken by an in-flight refresh or login. */
  function enqueueCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = credentialMutation.then(operation, operation)
    credentialMutation = run.then(() => undefined, () => undefined)
    return run
  }

  /** Retry a transient refresh only while the credential still exists. */
  async function scheduleRetryIfAuthenticated(): Promise<void> {
    await enqueueCredentialMutation(async () => {
      if (await loadCodexCredential(config.dshHome)) scheduleRefresh(Date.now(), 30_000)
    })
  }

  async function getCodexAccessToken(): Promise<string> {
    return enqueueCredentialMutation(async () => {
      const stored = await loadCodexCredential(config.dshHome)
      if (!stored) {
        await publishAuthState(false)
        throw errorWithCode('Codex authentication is required', 'CODEX_AUTH_REQUIRED')
      }
      if (stored.expiresAt > Date.now() + 60_000) {
        await setDshCredential(stored.accessToken)
        scheduleRefresh(stored.expiresAt)
        await publishAuthState(true)
        return stored.accessToken
      }
      try {
        const refreshed = await refreshCode(stored)
        await saveCodexCredential(refreshed, config.dshHome)
        await setDshCredential(refreshed.accessToken)
        scheduleRefresh(refreshed.expiresAt)
        await publishAuthState(true)
        ctx.logger.info('Codex token refreshed')
        return refreshed.accessToken
      } catch (error) {
        if ((error as { code?: string }).code === 'CODEX_AUTH_REQUIRED') {
          await clearCodexCredential(config.dshHome)
          await ctx.credentials.unset(CODEX_TOKEN_REF)
          await publishAuthState(false)
          throw error
        }
        throw error
      }
    })
  }

  async function handleCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${redirectPort}`)
    if (requestUrl.pathname !== '/auth/callback') {
      sendResponse(response, 404, 'Not found')
      return
    }
    const login = pending
    if (!login) {
      sendResponse(response, 400, 'No pending Codex login')
      return
    }
    try {
      const error = requestUrl.searchParams.get('error')
      if (error) throw errorWithCode('Codex OAuth authorization was denied', 'CODEX_OAUTH_FAILED')
      if (requestUrl.searchParams.get('state') !== login.state) throw errorWithCode('Codex OAuth state did not match', 'CODEX_OAUTH_STATE_MISMATCH')
      const code = requestUrl.searchParams.get('code')
      if (!code) throw errorWithCode('Codex OAuth callback did not include a code', 'CODEX_OAUTH_FAILED')
      await enqueueCredentialMutation(async () => {
        const credential = await exchangeCode(code, login.verifier, login.redirectUri)
        clearRefreshTimer()
        await saveCodexCredential(credential, config.dshHome)
        await setDshCredential(credential.accessToken)
        scheduleRefresh(credential.expiresAt)
        await publishAuthState(true)
        ctx.logger.info('Codex login succeeded')
      })
      sendResponse(response, 200, 'Codex login succeeded')
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'CODEX_OAUTH_FAILED'
      ctx.logger.warn(`Codex login failed (${code})`)
      sendResponse(response, code === 'CODEX_OAUTH_STATE_MISMATCH' ? 400 : 500, 'Codex login failed')
    } finally {
      pending = undefined
      await closeServer(login.server)
    }
  }

  async function startCodexLogin(): Promise<{ authUrl: string }> {
    if (pending) await closeServer(pending.server)
    const { verifier, challenge } = createPkce()
    const state = randomBytes(32).toString('base64url')
    const server = createServer((request, response) => {
      void handleCallback(request, response)
    })
    const actualPort = await listen(server, redirectPort)
    const redirectUri = `http://localhost:${actualPort}/auth/callback`
    pending = { server, verifier, state, redirectUri }
    const authUrl = new URL(CODEX_AUTHORIZE_URL)
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: CODEX_SCOPE,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    }).toString()
    ctx.logger.info('Codex login started')
    return { authUrl: authUrl.toString() }
  }

  async function initialize(): Promise<void> {
    const stored = await loadCodexCredential(config.dshHome)
    if (!stored) {
      await publishAuthState(false)
      return
    }
    try {
      await getCodexAccessToken()
    } catch (error) {
      if ((error as { code?: string }).code === 'CODEX_AUTH_REQUIRED') {
        ctx.logger.warn('Codex authentication is required')
        return
      }
      ctx.logger.warn('Codex startup token refresh failed')
      await scheduleRetryIfAuthenticated()
    }
  }

  async function logout(): Promise<void> {
    clearRefreshTimer()
    await enqueueCredentialMutation(async () => {
      clearRefreshTimer()
      await clearCodexCredential(config.dshHome)
      await ctx.credentials.unset(CODEX_TOKEN_REF)
      await publishAuthState(false)
    })
  }

  async function dispose(): Promise<void> {
    clearRefreshTimer()
    clearAuthStateRetry()
    if (pending) await closeServer(pending.server)
    pending = undefined
    await credentialMutation
    clearRefreshTimer()
  }

  return { startCodexLogin, getCodexAccessToken, initialize, logout, dispose }
}

export { createPkce, decodeJwtPayload, accountIdFromTokens }
