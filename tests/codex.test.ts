import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_TOKEN_URL,
  createCodexService,
  createPkce,
  decodeJwtPayload,
} from '../src/codex.js'
import { loadCodexCredential, saveCodexCredential } from '../src/storage.js'

function context(): { credentials: { set: ReturnType<typeof vi.fn>; unset: ReturnType<typeof vi.fn> }; logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }; values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    credentials: {
      set: vi.fn(async (ref: string, value: string) => void values.set(ref, value)),
      unset: vi.fn(async (ref: string) => void values.delete(ref)),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    values,
  }
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.`
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-oauth-codex-'))
}

afterEach(() => vi.restoreAllMocks())

describe('Codex OAuth', () => {
  it('creates a correct PKCE S256 challenge', () => {
    const { verifier, challenge } = createPkce()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('decodes account ID claims without verifying JWT signatures', () => {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })
    expect(decodeJwtPayload(token)).toMatchObject({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })
  })

  it('exchanges an authorization code and stores the credential', async () => {
    const dshHome = await home()
    const ctx = context()
    const originalFetch = globalThis.fetch
    const accessToken = jwt({ chatgpt_account_id: 'account-1' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === CODEX_TOKEN_URL) return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh', expires_in: 3600 }))
      return originalFetch(input)
    }))
    const service = createCodexService(ctx as never, { dshHome, codexRedirectPort: 0 })
    const { authUrl } = await service.startCodexLogin()
    const callbackPort = new URL(authUrl).searchParams.get('redirect_uri')!.match(/:(\d+)\//)![1]
    const state = new URL(authUrl).searchParams.get('state')!
    await originalFetch(`http://127.0.0.1:${callbackPort}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`)
    expect(await loadCodexCredential(dshHome)).toMatchObject({ accessToken, refreshToken: 'refresh', accountId: 'account-1' })
    expect(ctx.values.get('DSH_OPENAI_CODEX_TOKEN')).toBe(accessToken)
    await service.dispose()
  })

  it('rejects a mismatched OAuth state', async () => {
    const ctx = context()
    const service = createCodexService(ctx as never, { codexRedirectPort: 0 })
    const { authUrl } = await service.startCodexLogin()
    const port = new URL(authUrl).searchParams.get('redirect_uri')!.match(/:(\d+)\//)![1]
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=test&state=wrong`)
    expect(response.status).toBe(400)
    expect(ctx.logger.warn).toHaveBeenCalledWith('Codex login failed (CODEX_OAUTH_STATE_MISMATCH)')
    await service.dispose()
  })

  it('refreshes expired tokens and clears permanently invalid credentials', async () => {
    const dshHome = await home()
    const ctx = context()
    await saveCodexCredential({ accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0, accountId: 'account' }, dshHome)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 })))
    const service = createCodexService(ctx as never, { dshHome })
    expect(await service.getCodexAccessToken()).toBe('new')
    expect((await loadCodexCredential(dshHome))?.refreshToken).toBe('old-refresh')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'refresh_token_expired' }), { status: 400 })))
    await saveCodexCredential({ accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0, accountId: 'account' }, dshHome)
    await expect(service.getCodexAccessToken()).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' })
    expect(await loadCodexCredential(dshHome)).toBeUndefined()
    expect(ctx.credentials.unset).toHaveBeenCalled()
    await service.dispose()
  })
})
