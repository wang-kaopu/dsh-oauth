import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuth2Client } from 'google-auth-library'
import {
  createGeminiService,
  streamGemini,
  parseSse,
  type GeminiTransport,
} from '../src/gemini.js'
import { createGeminiRouteSync } from '../src/routes.js'
import { loadGeminiCredential, saveGeminiCredential } from '../src/storage.js'

function context() {
  return { logger: { info: vi.fn(), warn: vi.fn() } } as never
}

function fakeClient(request: (options: Record<string, unknown>) => unknown): OAuth2Client {
  return {
    on: vi.fn(),
    setCredentials: vi.fn(),
    getAccessToken: vi.fn(async () => ({ token: 'access' })),
    getToken: vi.fn(async () => ({ tokens: { access_token: 'access', refresh_token: 'refresh', expiry_date: Date.now() + 3_600_000 } })),
    generateAuthUrl: vi.fn((options: { state: string; redirect_uri?: string }) => `https://accounts.google.com/o/oauth2/auth?state=${encodeURIComponent(options.state)}&redirect_uri=${encodeURIComponent(options.redirect_uri ?? '')}`),
    request: vi.fn(async (options: Record<string, unknown>) => ({ status: 200, data: await request(options) })),
  } as unknown as OAuth2Client
}

function streamOf(events: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-oauth-gemini-'))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Gemini OAuth and Code Assist', () => {
  it('parses one event and multi-line data events', async () => {
    const events = [
      'event: message\ndata: {"response":{"ok":true}}\n\n',
      'data: {"response":\ndata: {"value":2}}\n\n',
    ]
    expect(await collect(parseSse(streamOf(events)))).toEqual([
      { response: { ok: true } },
      { response: { value: 2 } },
    ])
  })

  it('translates text, usage, and finish chunks in order', async () => {
    const transport: GeminiTransport = {
      getProjectId: vi.fn(async () => 'project-id'),
      getAccessToken: vi.fn(async () => 'access'),
      requestJson: vi.fn(),
      requestStream: vi.fn(async () => streamOf([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}\n\n',
        'data: {"response":{"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}}\n\n',
      ])),
      listModels: vi.fn(async () => []),
    }
    const options = { provider: 'gemini-cli-oauth', model: 'gemini-3-flash', messages: [] } as never
    const chunks = await collect(streamGemini(transport, options))
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'usage', 'block-end', 'finish'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } })
  })

  it('translates function calls and preserves tool-call finish reason', async () => {
    const transport: GeminiTransport = {
      getProjectId: vi.fn(async () => 'project-id'),
      getAccessToken: vi.fn(async () => 'access'),
      requestJson: vi.fn(),
      requestStream: vi.fn(async () => streamOf(['data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash","args":{"command":"ls"}}}]}}]}}\n\n'])),
      listModels: vi.fn(async () => []),
    }
    const chunks = await collect(streamGemini(transport, { provider: 'gemini-cli-oauth', model: 'gemini', messages: [] } as never))
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'tool-call-delta', 'block-end', 'usage', 'finish'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks[1]).toMatchObject({ name: 'bash', argumentsDelta: '{"command":"ls"}' })
  })

  it('loads Code Assist setup and rejects a missing project', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const requests: Record<string, unknown>[] = []
    const client = fakeClient(async options => {
      requests.push(options)
      return { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' }
    })
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    await expect(service.ensureGeminiCodeAssistSetup()).resolves.toEqual({ projectId: 'project-id' })
    expect(requests[0]).toMatchObject({ url: expect.stringContaining('loadCodeAssist'), method: 'POST' })

    const missingClient = fakeClient(async () => ({ currentTier: { id: 'free-tier' } }))
    const missingHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, missingHome)
    const missingService = createGeminiService(context(), { dshHome: missingHome, clientId: 'id', clientSecret: 'secret', createClient: () => missingClient })
    await expect(missingService.ensureGeminiCodeAssistSetup()).rejects.toMatchObject({ code: 'GEMINI_PROJECT_REQUIRED' })
  })

  it('publishes authentication state and hides models while unauthenticated', async () => {
    const dshHome = await home()
    const states: boolean[] = []
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', onAuthStateChange: state => void states.push(state), createClient: () => fakeClient(async () => ({})) })
    await service.initialize()
    expect(states).toEqual([false])
    await expect(service.listModels()).resolves.toEqual([])

    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const authenticated = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', onAuthStateChange: state => void states.push(state), createClient: () => fakeClient(async options => String(options.url).includes('loadCodeAssist') ? { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' } : { buckets: [] }) })
    await authenticated.initialize()
    expect(states).toEqual([false, true])
    await authenticated.logout()
    expect(states).toEqual([false, true, false])
    await service.dispose()
    await authenticated.dispose()
  })

  it('revokes the Gemini route when stream generation returns 401', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const replace = vi.fn()
    const registerAdapter = vi.fn(() => Object.assign(vi.fn(), { replace }))
    const client = fakeClient(async () => ({}))
    const routeContext = { logger: { info: vi.fn(), warn: vi.fn() }, llm: { registerAdapter } }
    const service = createGeminiService(routeContext as never, { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client, onAuthStateChange: createGeminiRouteSync(routeContext as never, {} as never) })
    await service.initialize()
    expect(registerAdapter).toHaveBeenCalledWith(['gemini-cli-oauth'], {})
    vi.mocked(client.request).mockResolvedValueOnce({ status: 401, data: {} } as never)

    await expect(service.requestStream({ url: 'https://example.test/stream', method: 'POST' })).rejects.toMatchObject({ code: 'GEMINI_AUTH_REQUIRED' })
    expect(replace).toHaveBeenCalledWith([])
    await expect(service.isAuthenticated()).resolves.toBe(false)
    await expect(loadGeminiCredential(dshHome)).resolves.toBeUndefined()
    await service.dispose()
  })

  it('keeps authentication and the route after a transient token refresh failure', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const states: boolean[] = []
    const client = fakeClient(async () => ({}))
    const replace = vi.fn()
    const registerAdapter = vi.fn(() => Object.assign(vi.fn(), { replace }))
    const routeContext = { logger: { info: vi.fn(), warn: vi.fn() }, llm: { registerAdapter } }
    const syncRoute = createGeminiRouteSync(routeContext as never, {} as never)
    const service = createGeminiService(routeContext as never, { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client, onAuthStateChange: state => { states.push(state); syncRoute(state) } })
    await service.initialize()
    vi.mocked(client.getAccessToken).mockRejectedValueOnce(new Error('temporary network failure'))

    await expect(service.getAccessToken()).rejects.toMatchObject({ code: 'GEMINI_REFRESH_FAILED' })
    expect(states).toEqual([true])
    expect(registerAdapter).toHaveBeenCalledWith(['gemini-cli-oauth'], {})
    expect(replace).not.toHaveBeenCalled()
    await expect(service.isAuthenticated()).resolves.toBe(true)
    await expect(loadGeminiCredential(dshHome)).resolves.toMatchObject({ refreshToken: 'refresh' })
    await service.dispose()
  })

  it('revokes authentication when OAuth refresh returns invalid_grant', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const client = fakeClient(async () => ({}))
    const states: boolean[] = []
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client, onAuthStateChange: state => void states.push(state) })
    await service.initialize()
    vi.mocked(client.getAccessToken).mockRejectedValueOnce({ response: { status: 400, data: { error: 'invalid_grant' } } })

    await expect(service.getAccessToken()).rejects.toMatchObject({ code: 'GEMINI_AUTH_REQUIRED' })
    expect(states).toEqual([true, false])
    await expect(service.isAuthenticated()).resolves.toBe(false)
    await expect(loadGeminiCredential(dshHome)).resolves.toBeUndefined()
    await service.dispose()
  })

  it('contains synchronous route retry failures', async () => {
    vi.useFakeTimers()
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const callback = vi.fn(() => { throw new Error('registration conflict') })
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => fakeClient(async () => ({})), onAuthStateChange: callback })

    await service.initialize()
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(callback).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('exchanges Gemini OAuth code and rejects a mismatched state', async () => {
    const dshHome = await home()
    const client = fakeClient(async () => ({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' }))
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    const { authUrl } = await service.startGeminiLogin()
    const redirectUri = decodeURIComponent(new URL(authUrl).searchParams.get('redirect_uri')!)
    const response = await fetch(`${redirectUri}?state=wrong`)
    expect(response.status).toBe(400)
    await service.dispose()

    const secondClient = fakeClient(async () => ({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' }))
    const secondService = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => secondClient, onAuthStateChange: async () => { throw new Error('adapter unavailable') } })
    const secondLogin = await secondService.startGeminiLogin()
    const state = new URL(secondLogin.authUrl).searchParams.get('state')!
    const secondRedirectUri = decodeURIComponent(new URL(secondLogin.authUrl).searchParams.get('redirect_uri')!)
    const callback = await fetch(`${secondRedirectUri}?code=code&state=${encodeURIComponent(state)}`)
    expect(callback.status).toBe(200)
    await expect((await import('../src/storage.js')).loadGeminiCredential(dshHome)).resolves.toMatchObject({ accessToken: 'access', refreshToken: 'refresh', projectId: 'project-id' })
    await secondService.dispose()
  })

  it('polls onboarding operations and saves the resolved project', async () => {
    const originalSetTimeout = globalThis.setTimeout
    const timer = vi.spyOn(globalThis, 'setTimeout')
    timer.mockImplementation(((handler: (...args: unknown[]) => void) => originalSetTimeout(handler, 0)) as never)
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    let calls = 0
    const client = fakeClient(async options => {
      calls += 1
      if (calls === 1) return { allowedTiers: [{ id: 'free-tier', isDefault: true }] }
      if (calls === 2) return { done: false, name: 'operations/test' }
      return { done: true, response: { cloudaicompanionProject: { id: 'project-id', name: 'Project' } } }
    })
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    await expect(service.ensureGeminiCodeAssistSetup()).resolves.toEqual({ projectId: 'project-id' })
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 5_000)
  })

  it('reports account validation before trying to select an onboarding tier', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const client = fakeClient(async () => ({ ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED', validationUrl: 'https://example.test/verify' }] }))
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    await expect(service.ensureGeminiCodeAssistSetup()).rejects.toMatchObject({ code: 'GEMINI_VALIDATION_REQUIRED', message: 'Gemini Code Assist account validation is required' })
    await service.dispose()
  })

  it('classifies every other non-empty ineligible tier list as account ineligible', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const client = fakeClient(async () => ({ ineligibleTiers: [{ reasonCode: 'RESTRICTED_NETWORK' }] }))
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    await expect(service.ensureGeminiCodeAssistSetup()).rejects.toMatchObject({ code: 'GEMINI_ACCOUNT_NOT_ELIGIBLE', message: 'Gemini Code Assist account is not eligible' })
    await service.dispose()
  })

  it('classifies Gaxios error response data instead of losing the upstream error code', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const client = fakeClient(async () => ({}))
    vi.mocked(client.request).mockRejectedValueOnce({ response: { status: 403, data: { error: { message: 'account validation required' } } } })
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    await expect(service.requestJson({ url: 'https://example.test', method: 'POST' })).rejects.toMatchObject({ code: 'GEMINI_VALIDATION_REQUIRED' })
    await service.dispose()
  })

  it('discovers, deduplicates, caches, and formats remote Gemini models', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    const requests: Record<string, unknown>[] = []
    const client = fakeClient(async options => {
      requests.push(options)
      if (String(options.url).includes('loadCodeAssist')) return { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' }
      return { buckets: [{ modelId: 'gemini-3.1-pro-preview' }, { modelId: 'gemini-3-flash' }, { modelId: 'gemini-3-flash' }, {}, { modelId: '  ' }] }
    })
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    const adapter = new (await import('../src/gemini.js')).GeminiCliAdapter(service)

    await expect(service.listModels()).resolves.toEqual(['gemini-3.1-pro-preview', 'gemini-3-flash'])
    await expect(service.listModels()).resolves.toEqual(['gemini-3.1-pro-preview', 'gemini-3-flash'])
    expect(requests.filter(request => String(request.url).includes('retrieveUserQuota'))).toHaveLength(1)
    await expect(adapter.listModels('gemini-cli-oauth')).resolves.toEqual([
      { provider: 'gemini-cli-oauth', id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
      { provider: 'gemini-cli-oauth', id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    ])
    await service.logout()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    await expect(service.listModels()).resolves.toEqual(['gemini-3.1-pro-preview', 'gemini-3-flash'])
    expect(requests.filter(request => String(request.url).includes('retrieveUserQuota'))).toHaveLength(2)
    await service.dispose()
  })

  it('returns last-known-good models after a temporary refresh failure', async () => {
    vi.useFakeTimers()
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    let quotaCalls = 0
    const client = fakeClient(async options => {
      if (String(options.url).includes('loadCodeAssist')) return { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' }
      quotaCalls += 1
      if (quotaCalls > 1) throw new Error('temporary failure')
      return { buckets: [{ modelId: 'gemini-3-flash' }] }
    })
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    await expect(service.listModels()).resolves.toEqual(['gemini-3-flash'])
    vi.setSystemTime(Date.now() + 5 * 60_001)
    await expect(service.listModels()).resolves.toEqual(['gemini-3-flash'])
    expect(quotaCalls).toBe(2)
    await service.dispose()
  })

  it('keeps last-known-good models when quota discovery returns empty buckets', async () => {
    vi.useFakeTimers()
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh' }, dshHome)
    let quotaCalls = 0
    let returnEmpty = false
    const logger = { info: vi.fn(), warn: vi.fn() }
    const client = fakeClient(async options => {
      if (String(options.url).includes('loadCodeAssist')) return { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' }
      quotaCalls += 1
      return returnEmpty ? { buckets: [] } : { buckets: [{ modelId: 'gemini-3-flash' }] }
    })
    const service = createGeminiService({ logger } as never, { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    await expect(service.listModels()).resolves.toEqual(['gemini-3-flash'])
    returnEmpty = true
    vi.setSystemTime(Date.now() + 5 * 60_001)

    await expect(service.listModels()).resolves.toEqual(['gemini-3-flash'])
    expect(quotaCalls).toBe(2)
    expect(logger.warn).toHaveBeenCalledWith('Gemini model discovery returned no model IDs; using cached models')
    await service.dispose()
  })

  it('does not reuse or cache a pending model discovery across logout and login', async () => {
    const dshHome = await home()
    await saveGeminiCredential({ refreshToken: 'refresh-a' }, dshHome)
    let quotaCall = 0
    let signalQuotaStarted!: () => void
    const quotaStarted = new Promise<void>(resolve => { signalQuotaStarted = resolve })
    let resolveOldQuota!: (value: unknown) => void
    const oldQuota = new Promise<unknown>(resolve => { resolveOldQuota = resolve })
    const client = fakeClient(async options => {
      if (String(options.url).includes('loadCodeAssist')) return { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-id' }
      quotaCall += 1
      if (quotaCall === 1) {
        signalQuotaStarted()
        return oldQuota
      }
      return { buckets: [{ modelId: 'gemini-b-model' }] }
    })
    const service = createGeminiService(context(), { dshHome, clientId: 'id', clientSecret: 'secret', createClient: () => client })
    const oldModels = service.listModels()
    await quotaStarted

    await service.logout()
    await saveGeminiCredential({ refreshToken: 'refresh-b' }, dshHome)
    const newModels = service.listModels()
    await expect(newModels).resolves.toEqual(['gemini-b-model'])
    resolveOldQuota({ buckets: [{ modelId: 'gemini-a-model' }] })
    await expect(oldModels).resolves.toEqual([])
    expect(quotaCall).toBe(2)
    await service.dispose()
  })

  it('rejects unsupported reasoning and reasoning history before Gemini I/O', async () => {
    const transport: GeminiTransport = {
      getProjectId: vi.fn(),
      getAccessToken: vi.fn(),
      requestJson: vi.fn(),
      requestStream: vi.fn(),
      listModels: vi.fn(async () => []),
    }
    await expect(collect(streamGemini(transport, { provider: 'gemini-cli-oauth', model: 'gemini', messages: [], reasoningEffort: 'high' } as never))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    await expect(collect(streamGemini(transport, { provider: 'gemini-cli-oauth', model: 'gemini', messages: [{ content: [{ type: 'reasoning', text: 'private thought' }] }] } as never))).rejects.toMatchObject({ code: 'GEMINI_REASONING_HISTORY_UNSUPPORTED' })
    expect(transport.getProjectId).toHaveBeenCalledTimes(1)
  })

  it('honors an already-aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = { getProjectId: vi.fn(), requestStream: vi.fn() } as unknown as GeminiTransport
    await expect(collect(streamGemini(transport, { provider: 'gemini-cli-oauth', model: 'gemini', messages: [], signal: controller.signal } as never))).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.getProjectId).not.toHaveBeenCalled()
  })
})
