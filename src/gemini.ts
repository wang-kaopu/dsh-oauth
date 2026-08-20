import { OAuth2Client, type Credentials } from 'google-auth-library'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders,
  CallId,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import * as net from 'node:net'
import { randomUUID, randomBytes } from 'node:crypto'
import {
  clearGeminiCredential,
  loadGeminiCredential,
  saveGeminiCredential,
  type GeminiCredential,
} from './storage.js'

export const GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const
export const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
export const CODE_ASSIST_API_VERSION = 'v1internal'
export const GEMINI_CLIENT_ID_ENV = 'GEMINI_CLIENT_ID'
export const GEMINI_CLIENT_SECRET_ENV = 'GEMINI_CLIENT_SECRET'
export const GEMINI_CLIENT_ID = process.env[GEMINI_CLIENT_ID_ENV] ?? ''
export const GEMINI_CLIENT_SECRET = process.env[GEMINI_CLIENT_SECRET_ENV] ?? ''

export interface GeminiServiceConfig {
  dshHome?: string
  clientId?: string
  clientSecret?: string
  createClient?: (clientId: string, clientSecret: string) => OAuth2Client
}

interface GeminiLogin {
  server: Server
  client: OAuth2Client
  state: string
  redirectUri: string
}

interface CodeAssistTier {
  id?: string
  name?: string
  isDefault?: boolean
}

interface IneligibleTier {
  reasonCode?: string
  validationUrl?: string
}

interface CodeAssistError {
  code?: number
  status?: string
  message?: string
}

interface LoadCodeAssistResponse {
  currentTier?: CodeAssistTier | null
  allowedTiers?: CodeAssistTier[] | null
  ineligibleTiers?: IneligibleTier[] | null
  cloudaicompanionProject?: string | null
  paidTier?: CodeAssistTier | null
}

interface OnboardOperationResponse {
  done?: boolean
  name?: string
  response?: {
    cloudaicompanionProject?: {
      id?: string
      name?: string
    }
  }
  error?: CodeAssistError
}

interface CodeAssistErrorResponse {
  error?: CodeAssistError
}

interface GeminiRequestOptions {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  params?: Record<string, string>
  responseType?: 'stream'
  signal?: AbortSignal
}

interface GeminiRequestResponse<T = unknown> {
  status?: number
  data: T
}

export interface GeminiTransport {
  getProjectId(signal?: AbortSignal): Promise<string>
  requestJson<T>(options: GeminiRequestOptions): Promise<T>
  requestStream(options: GeminiRequestOptions): Promise<AsyncIterable<Uint8Array | string>>
  getAccessToken(): Promise<string>
}

/**
 * Build a Code Assist method URL from the stable endpoint and API version.
 *
 * @param method - v1internal method name such as `loadCodeAssist`.
 * @returns the method URL.
 */
export function getMethodUrl(method: string): string {
  return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`
}

/**
 * Create a Google OAuth client from explicit credentials.
 *
 * @param clientId - Google installed-app OAuth client ID.
 * @param clientSecret - Google installed-app OAuth client secret.
 * @returns an OAuth2 client that owns refresh behavior.
 */
export function createGeminiOAuthClient(clientId: string, clientSecret: string): OAuth2Client {
  return new OAuth2Client({ clientId, clientSecret })
}

/**
 * Find an unused loopback TCP port.
 *
 * @returns an OS-assigned local port.
 */
export async function getAvailablePort(): Promise<number> {
  const server = net.createServer()
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
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!port) throw new Error('The operating system did not provide a loopback port')
  return port
}

/**
 * Parse a line-oriented SSE stream without buffering the whole response.
 *
 * @param stream - byte or string chunks from the HTTP response.
 * @param onMalformed - optional diagnostic callback for malformed JSON events.
 * @yields parsed SSE data objects.
 */
export async function* parseSse(stream: AsyncIterable<Uint8Array | string>, onMalformed: (error: unknown) => void = () => console.debug('Gemini SSE event was malformed and was skipped')): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let pendingText = ''
  let dataLines: string[] = []

  const flushEvent = function* (): Generator<Record<string, unknown>> {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    if (data === '[DONE]') return
    try {
      const parsed = JSON.parse(data) as unknown
      if (typeof parsed === 'object' && parsed !== null) yield parsed as Record<string, unknown>
    } catch (error) {
      onMalformed(error)
    }
  }

  const consumeLine = function* (line: string): Generator<Record<string, unknown>> {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (normalized === '') {
      yield* flushEvent()
      return
    }
    if (normalized.startsWith('data: ')) dataLines.push(normalized.slice(6))
    else if (normalized.startsWith('data:')) dataLines.push(normalized.slice(5).replace(/^ /, ''))
  }

  for await (const chunk of stream) {
    pendingText += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let newlineIndex = pendingText.indexOf('\n')
    while (newlineIndex >= 0) {
      yield* consumeLine(pendingText.slice(0, newlineIndex))
      pendingText = pendingText.slice(newlineIndex + 1)
      newlineIndex = pendingText.indexOf('\n')
    }
  }
  pendingText += decoder.decode()
  if (pendingText.length > 0) yield* consumeLine(pendingText)
  yield* flushEvent()
}

function geminiError(message: string, code: string, cause?: unknown, status?: number): LlmError {
  return new LlmError(message, code, { ...(cause === undefined ? {} : { cause }), ...(status === undefined ? {} : { status }) })
}

function projectIdIsNumeric(projectId: string): boolean {
  return /^\d+$/.test(projectId)
}

function selectedProjectId(stored: GeminiCredential | undefined): string | undefined {
  const value = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID ?? stored?.projectId
  if (value !== undefined && projectIdIsNumeric(value)) throw geminiError('A Google Cloud project number cannot be used as a project ID', 'GEMINI_INVALID_PROJECT_ID')
  return value
}

function errorCodeFromResponse(error: CodeAssistError | undefined, fallback: string): string {
  const value = `${error?.status ?? ''} ${error?.message ?? ''}`.toUpperCase()
  if (value.includes('VALIDATION')) return 'GEMINI_VALIDATION_REQUIRED'
  if (value.includes('ELIGIBLE')) return 'GEMINI_ACCOUNT_NOT_ELIGIBLE'
  return fallback
}

/** Map Code Assist account eligibility reasons to the bridge's stable error codes. */
function ineligibleTierErrorCode(tiers: IneligibleTier[] | null | undefined): string | undefined {
  if (!tiers?.length) return undefined
  if (tiers.some(tier => tier.reasonCode === 'VALIDATION_REQUIRED')) return 'GEMINI_VALIDATION_REQUIRED'
  return 'GEMINI_ACCOUNT_NOT_ELIGIBLE'
}

/** Extract the structured Gaxios response needed for stable provider error classification. */
function errorResponse(error: unknown): { status?: number; data?: CodeAssistErrorResponse } {
  const response = (error as { response?: { status?: number; data?: unknown } }).response
  const data = typeof response?.data === 'object' && response.data !== null ? response.data as CodeAssistErrorResponse : undefined
  return { status: response?.status, data }
}

function responseHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DSH OAuth Bridge</title></head><body><p>${message}</p><p>You can close this window.</p></body></html>`
}

function sendResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(responseHtml(message))
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isFreeTier(tier: CodeAssistTier): boolean {
  return `${tier.id ?? ''} ${tier.name ?? ''}`.toLowerCase().includes('free')
}

function contentParts(message: Message, toolNames: ReadonlyMap<string, string>): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ text: block.text })
      continue
    }
    if (block.type === 'reasoning') throw geminiError('Gemini does not support reasoning history', 'GEMINI_REASONING_HISTORY_UNSUPPORTED')
    if (block.type === 'tool-call') {
      let args: unknown = {}
      try {
        args = JSON.parse(block.arguments) as unknown
      } catch {
        throw geminiError('A tool call contained invalid JSON arguments', 'GEMINI_STREAM_ERROR')
      }
      parts.push({ functionCall: { name: block.name, args } })
      continue
    }
    if (block.type === 'tool-result') {
      const response: Record<string, unknown> = {}
      for (const result of block.content) {
        if (result.type === 'text') response.output = `${response.output ?? ''}${result.text}`
      }
      if (block.isError) response.error = true
      parts.push({ functionResponse: { name: toolNames.get(block.toolCallId) ?? block.toolCallId, response } })
      continue
    }
    throw geminiError(`Gemini does not support DSH content block ${block.type}`, 'GEMINI_STREAM_ERROR')
  }
  return parts
}

function convertContents(messages: Message[]): Record<string, unknown>[] {
  const toolNames = new Map<string, string>()
  return messages.map(message => {
    for (const block of message.content) {
      if (block.type === 'tool-call') toolNames.set(block.id, block.name)
    }
    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: contentParts(message, toolNames),
    }
  })
}

function convertTools(tools: ToolSchema[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }]
}

function toGenerateRequest(options: GenerateOptions, project: string): Record<string, unknown> {
  const generationConfig = {
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stopSequences: options.stop }),
  }
  return {
    model: options.model,
    project,
    ...(options.sessionId === undefined ? {} : { user_prompt_id: String(options.sessionId) }),
    request: {
      contents: convertContents(options.messages),
      ...(options.system === undefined ? {} : { systemInstruction: { parts: [{ text: options.system }] } }),
      ...(convertTools(options.tools) === undefined ? {} : { tools: convertTools(options.tools) }),
      ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
      ...(options.sessionId === undefined ? {} : { session_id: String(options.sessionId) }),
    },
  }
}

function responseFromEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const response = event.response
  return typeof response === 'object' && response !== null ? response as Record<string, unknown> : undefined
}

function responseParts(response: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = response.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const content = candidates[0]
  if (typeof content !== 'object' || content === null) return []
  const candidateContent = (content as Record<string, unknown>).content
  if (typeof candidateContent !== 'object' || candidateContent === null) return []
  const parts = (candidateContent as Record<string, unknown>).parts
  return Array.isArray(parts) ? parts.filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null) : []
}

/**
 * Create the Gemini Code Assist OAuth and transport service.
 *
 * @param ctx - DSH context used for lifecycle-safe diagnostics.
 * @param config - storage, OAuth, and test transport configuration.
 * @returns the service consumed by the adapter and control server.
 */
export function createGeminiService(ctx: Context, config: GeminiServiceConfig = {}): GeminiTransport & {
  startGeminiLogin(): Promise<{ authUrl: string }>
  initialize(): Promise<void>
  logout(): Promise<void>
  dispose(): Promise<void>
  isAuthenticated(): Promise<boolean>
  ensureGeminiCodeAssistSetup(client?: OAuth2Client): Promise<{ projectId: string }>
} {
  const clientId = config.clientId ?? process.env[GEMINI_CLIENT_ID_ENV] ?? GEMINI_CLIENT_ID
  const clientSecret = config.clientSecret ?? process.env[GEMINI_CLIENT_SECRET_ENV] ?? GEMINI_CLIENT_SECRET
  const makeClient = config.createClient ?? createGeminiOAuthClient
  let client: OAuth2Client | undefined
  let projectCache: string | undefined
  let pending: GeminiLogin | undefined

  async function persistTokens(tokens: Credentials): Promise<void> {
    const old = await loadGeminiCredential(config.dshHome)
    if (!old) return
    await saveGeminiCredential({
      ...old,
      ...(tokens.access_token == null ? {} : { accessToken: tokens.access_token }),
      ...(tokens.refresh_token == null ? {} : { refreshToken: tokens.refresh_token }),
      ...(tokens.expiry_date == null ? {} : { expiresAt: tokens.expiry_date }),
    }, config.dshHome)
  }

  function attachTokenPersistence(oauthClient: OAuth2Client): void {
    oauthClient.on('tokens', tokens => {
      void persistTokens(tokens).catch(() => ctx.logger.warn('Gemini token persistence failed'))
    })
  }

  async function getClient(): Promise<OAuth2Client> {
    if (client) return client
    if (!clientId || !clientSecret) throw geminiError('Gemini OAuth client credentials are not configured', 'GEMINI_OAUTH_FAILED')
    const stored = await loadGeminiCredential(config.dshHome)
    if (!stored?.refreshToken) throw geminiError('Gemini authentication is required', 'GEMINI_AUTH_REQUIRED')
    client = makeClient(clientId, clientSecret)
    attachTokenPersistence(client)
    client.setCredentials({
      ...(stored.accessToken === undefined ? {} : { access_token: stored.accessToken }),
      refresh_token: stored.refreshToken,
      ...(stored.expiresAt === undefined ? {} : { expiry_date: stored.expiresAt }),
    })
    return client
  }

  async function getAccessToken(): Promise<string> {
    const oauthClient = await getClient()
    try {
      const result = await oauthClient.getAccessToken()
      if (!result.token) throw geminiError('Gemini OAuth did not return an access token', 'GEMINI_AUTH_REQUIRED')
      return result.token
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith('GEMINI_')) throw error
      throw geminiError('Gemini OAuth token refresh failed', 'GEMINI_AUTH_REQUIRED', error)
    }
  }

  async function requestJson<T>(options: GeminiRequestOptions): Promise<T> {
    const oauthClient = await getClient()
    try {
      const response = await oauthClient.request<T>({ ...options, headers: { ...(options.headers ?? {}), 'content-type': options.headers?.['content-type'] ?? 'application/json' } }) as unknown as GeminiRequestResponse<T>
      if (response.status !== undefined && response.status >= 400) {
        const data = response.data as unknown as CodeAssistErrorResponse
        throw geminiError('Gemini Code Assist request failed', errorCodeFromResponse(data.error, 'GEMINI_HTTP_ERROR'), undefined, response.status)
      }
      return response.data
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith('GEMINI_')) throw error
      const { status, data } = errorResponse(error)
      const code = status === 401 ? 'GEMINI_AUTH_REQUIRED' : errorCodeFromResponse(data?.error, 'GEMINI_HTTP_ERROR')
      throw geminiError(status === 401 ? 'Gemini authentication is required' : 'Gemini Code Assist request failed', code, error, status)
    }
  }

  async function requestStream(options: GeminiRequestOptions): Promise<AsyncIterable<Uint8Array | string>> {
    const oauthClient = await getClient()
    try {
      const response = await oauthClient.request<unknown>({ ...options, responseType: 'stream', headers: { ...(options.headers ?? {}), 'content-type': options.headers?.['content-type'] ?? 'application/json' } }) as unknown as GeminiRequestResponse<AsyncIterable<Uint8Array | string>>
      if (response.status !== undefined && response.status >= 400) throw geminiError('Gemini stream request failed', response.status === 401 ? 'GEMINI_AUTH_REQUIRED' : 'GEMINI_HTTP_ERROR', undefined, response.status)
      return response.data
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith('GEMINI_')) throw error
      const { status, data } = errorResponse(error)
      const code = status === 401 ? 'GEMINI_AUTH_REQUIRED' : errorCodeFromResponse(data?.error, 'GEMINI_HTTP_ERROR')
      throw geminiError(status === 401 ? 'Gemini authentication is required' : 'Gemini stream request failed', code, error, status)
    }
  }

  async function ensureGeminiCodeAssistSetup(oauthClient?: OAuth2Client, signal?: AbortSignal): Promise<{ projectId: string }> {
    const activeClient = oauthClient ?? await getClient()
    client ??= activeClient
    const stored = await loadGeminiCredential(config.dshHome)
    const localProjectId = selectedProjectId(stored)
    const request = {
      cloudaicompanionProject: localProjectId,
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', ...(localProjectId === undefined ? {} : { duetProject: localProjectId }) },
    }
    const load = await requestJson<LoadCodeAssistResponse>({ url: getMethodUrl('loadCodeAssist'), method: 'POST', body: JSON.stringify(request), headers: attributionHeaders(), signal })
    let resolvedProject = load.cloudaicompanionProject ?? localProjectId
    if (!load.currentTier) {
      const ineligibleCode = ineligibleTierErrorCode(load.ineligibleTiers)
      if (ineligibleCode) {
        const message = ineligibleCode === 'GEMINI_VALIDATION_REQUIRED'
          ? 'Gemini Code Assist account validation is required'
          : 'Gemini Code Assist account is not eligible'
        throw geminiError(message, ineligibleCode)
      }
      const tier = load.allowedTiers?.find(candidate => candidate.isDefault)
      if (!tier?.id) throw geminiError('Gemini Code Assist returned no default tier', 'GEMINI_NO_ALLOWED_TIER')
      if (!isFreeTier(tier) && !localProjectId) throw geminiError('A Google Cloud project is required for the selected Gemini tier', 'GEMINI_PROJECT_REQUIRED')
      const onboardRequest = {
        tierId: tier.id,
        ...(isFreeTier(tier) ? {} : { cloudaicompanionProject: localProjectId }),
        metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', ...(isFreeTier(tier) ? {} : { duetProject: localProjectId }) },
      }
      let operation = await requestJson<OnboardOperationResponse>({ url: getMethodUrl('onboardUser'), method: 'POST', body: JSON.stringify(onboardRequest), headers: attributionHeaders(), signal })
      if (operation.done === false && operation.name) {
        const deadline = Date.now() + 60_000
        while (!operation.done && Date.now() < deadline) {
          await delay(5_000, signal)
          operation = await requestJson<OnboardOperationResponse>({ url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}/${operation.name}`, method: 'GET', headers: attributionHeaders(), signal })
        }
        if (!operation.done) throw geminiError('Gemini Code Assist onboarding timed out', 'GEMINI_ONBOARDING_TIMEOUT')
      }
      if (operation.error) throw geminiError('Gemini Code Assist onboarding failed', errorCodeFromResponse(operation.error, 'GEMINI_ONBOARDING_FAILED'))
      resolvedProject = operation.response?.cloudaicompanionProject?.id ?? localProjectId
    }
    if (!resolvedProject) throw geminiError('Gemini Code Assist did not return a project ID', 'GEMINI_PROJECT_REQUIRED')
    if (projectIdIsNumeric(resolvedProject)) throw geminiError('Gemini Code Assist returned a project number instead of a project ID', 'GEMINI_INVALID_PROJECT_ID')
    projectCache = resolvedProject
    const latest = await loadGeminiCredential(config.dshHome)
    if (latest) await saveGeminiCredential({ ...latest, projectId: resolvedProject }, config.dshHome)
    ctx.logger.info('Gemini Code Assist setup completed')
    return { projectId: resolvedProject }
  }

  async function getProjectId(signal?: AbortSignal): Promise<string> {
    if (projectCache) return projectCache
    return (await ensureGeminiCodeAssistSetup(undefined, signal)).projectId
  }

  async function handleCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const login = pending
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (requestUrl.pathname !== '/oauth2callback') {
      sendResponse(response, 404, 'Not found')
      return
    }
    if (!login) {
      sendResponse(response, 400, 'No pending Gemini login')
      return
    }
    try {
      if (requestUrl.searchParams.get('error')) throw geminiError('Gemini OAuth authorization was denied', 'GEMINI_OAUTH_FAILED')
      if (requestUrl.searchParams.get('state') !== login.state) throw geminiError('Gemini OAuth state did not match', 'GEMINI_OAUTH_STATE_MISMATCH')
      const code = requestUrl.searchParams.get('code')
      if (!code) throw geminiError('Gemini OAuth callback did not include a code', 'GEMINI_OAUTH_FAILED')
      const { tokens } = await login.client.getToken({ code, redirect_uri: login.redirectUri })
      if (!tokens.refresh_token) throw geminiError('Gemini OAuth did not return a refresh token', 'GEMINI_REFRESH_TOKEN_MISSING')
      login.client.setCredentials(tokens)
      await saveGeminiCredential({
        ...(tokens.access_token == null ? {} : { accessToken: tokens.access_token }),
        refreshToken: tokens.refresh_token,
        ...(tokens.expiry_date == null ? {} : { expiresAt: tokens.expiry_date }),
      }, config.dshHome)
      client = login.client
      await ensureGeminiCodeAssistSetup(login.client)
      ctx.logger.info('Gemini login succeeded')
      sendResponse(response, 200, 'Gemini login succeeded')
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'GEMINI_OAUTH_FAILED'
      ctx.logger.warn(`Gemini login failed (${code})`)
      sendResponse(response, code === 'GEMINI_OAUTH_STATE_MISMATCH' ? 400 : 500, 'Gemini login failed')
    } finally {
      pending = undefined
      await closeServer(login.server)
    }
  }

  async function startGeminiLogin(): Promise<{ authUrl: string }> {
    if (!clientId || !clientSecret) throw geminiError('Gemini OAuth client credentials are not configured', 'GEMINI_OAUTH_FAILED')
    if (pending) await closeServer(pending.server)
    const port = await getAvailablePort()
    const oauthClient = makeClient(clientId, clientSecret)
    attachTokenPersistence(oauthClient)
    const state = randomBytes(32).toString('base64url')
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
    const server = createServer((request, response) => {
      void handleCallback(request, response)
    })
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
    pending = { server, client: oauthClient, state, redirectUri }
    const authUrl = oauthClient.generateAuthUrl({ access_type: 'offline', scope: [...GEMINI_SCOPES], state, redirect_uri: redirectUri })
    ctx.logger.info('Gemini login started')
    return { authUrl }
  }

  async function initialize(): Promise<void> {
    if (await isAuthenticated()) {
      try {
        await getClient()
      } catch {
        ctx.logger.warn('Gemini authentication could not be restored')
      }
    }
  }

  async function isAuthenticated(): Promise<boolean> {
    return Boolean((await loadGeminiCredential(config.dshHome))?.refreshToken)
  }

  async function logout(): Promise<void> {
    await clearGeminiCredential(config.dshHome)
    client = undefined
    projectCache = undefined
  }

  async function dispose(): Promise<void> {
    if (pending) await closeServer(pending.server)
    pending = undefined
    client = undefined
    projectCache = undefined
  }

  return { getProjectId, requestJson, requestStream, getAccessToken, startGeminiLogin, initialize, logout, dispose, isAuthenticated, ensureGeminiCodeAssistSetup }
}

/**
 * Convert Gemini Code Assist streaming events into DSH stream chunks.
 *
 * @param transport - authenticated Gemini transport.
 * @param options - provider-neutral DSH generation request.
 * @returns an async stream ending with exactly one finish chunk.
 */
export async function* streamGemini(transport: GeminiTransport, options: GenerateOptions): AsyncIterable<StreamChunk> {
  if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  if (options.reasoningEffort !== undefined) throw geminiError('Gemini reasoning effort is not supported', 'UNSUPPORTED_REASONING_EFFORT')
  const project = await transport.getProjectId(options.signal)
  const request = toGenerateRequest(options, project)
  const stream = await transport.requestStream({
    url: getMethodUrl('streamGenerateContent'),
    method: 'POST',
    params: { alt: 'sse' },
    headers: attributionHeaders(),
    body: JSON.stringify(request),
    signal: options.signal,
  })
  let textIndex: number | undefined
  let completeText = ''
  let nextIndex = 0
  let hasToolCall = false
  let usageEmitted = false
  for await (const event of parseSse(stream)) {
    if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    if (event.error) throw geminiError('Gemini stream returned an error event', 'GEMINI_STREAM_ERROR')
    const response = responseFromEvent(event)
    if (!response) continue
    const parts = responseParts(response)
    for (const part of parts) {
      if (typeof part.text === 'string') {
        if (textIndex === undefined) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        completeText += part.text
        yield { type: 'text-delta', index: textIndex, text: part.text }
      }
      const functionCall = part.functionCall
      if (typeof functionCall === 'object' && functionCall !== null) {
        const call = functionCall as Record<string, unknown>
        const name = typeof call.name === 'string' ? call.name : 'unknown'
        const args = call.args ?? {}
        const id = CallId(randomUUID())
        const index = nextIndex++
        const argumentsJson = JSON.stringify(args)
        hasToolCall = true
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } }
      }
    }
    const usage = response.usageMetadata
    if (!usageEmitted && typeof usage === 'object' && usage !== null) {
      const metadata = usage as Record<string, unknown>
      yield { type: 'usage', usage: { inputTokens: typeof metadata.promptTokenCount === 'number' ? metadata.promptTokenCount : 0, outputTokens: typeof metadata.candidatesTokenCount === 'number' ? metadata.candidatesTokenCount : 0 } }
      usageEmitted = true
    }
  }
  if (textIndex !== undefined) yield { type: 'block-end', index: textIndex, block: { type: 'text', text: completeText } }
  if (!usageEmitted) yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: hasToolCall ? 'tool-calls' : 'stop' } }
}

/**
 * DSH adapter for the Gemini CLI Code Assist route.
 */
export class GeminiCliAdapter extends LlmAdapter {
  constructor(private readonly transport: GeminiTransport) {
    super()
  }

  /**
   * Stream one DSH request through Gemini Code Assist.
   *
   * @param options - provider-neutral model request.
   * @returns translated DSH stream chunks.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return streamGemini(this.transport, options)
  }

  /**
   * Return the configured route's currently selected project metadata.
   *
   * @param provider - registered provider route.
   * @returns provider/model descriptor.
   */
  async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return { provider, id: model, name: model }
  }

  /**
   * Keep model discovery advisory; the DSH configuration supplies the model ID.
   *
   * @param provider - provider route being queried.
   * @returns no fabricated model IDs.
   */
  async listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    if (provider !== 'gemini-cli-oauth') return []
    return [
      { provider, id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { provider, id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ]
  }
}
