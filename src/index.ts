import type { Context } from '@deepseek-ai/cordis'
import { loadCodexCredential } from './storage.js'
import { createCodexService } from './codex.js'
import { createGeminiService, GeminiCliAdapter } from './gemini.js'
import { createCodexRouteSync, createGeminiRouteSync } from './routes.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface Config {
  dshHome?: string
  controlPort?: number
  codexRedirectPort?: number
  /** Google installed-app OAuth client id; falls back to GEMINI_CLIENT_ID. */
  clientId?: string
  /** Google installed-app OAuth client secret; falls back to GEMINI_CLIENT_SECRET. */
  clientSecret?: string
  /** Google Cloud project id for paid tiers; falls back to GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID. */
  projectId?: string
}

export const name = '@kelvinwww/dsh-oauth'
export const inject = ['credentials', 'llm', 'settings'] as const

/** Narrow face of the harness `webServer` service used for the same-origin route. */
interface WebServerFace {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void
  }): () => void
}

interface ControlDependencies {
  codex: {
    startCodexLogin(): Promise<{ authUrl: string }>
    logout(): Promise<void>
  }
  gemini: {
    startGeminiLogin(): Promise<{ authUrl: string }>
    logout(): Promise<void>
    isAuthenticated(): Promise<boolean>
  }
  dshHome?: string
  port: number
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

function jsonResponse(response: ServerResponse, status: number, value: unknown, origin?: string): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  })
  response.end(JSON.stringify(value))
}

/**
 * Serve the loopback OAuth control API for one request.
 *
 * Also mounted on the harness `webServer` so browser clients can reach it
 * same-origin (the desktop shell blocks cross-port renderer fetches). When
 * mounted under a path prefix, that prefix is stripped before routing.
 */
export async function handleControlRequest(dependencies: ControlDependencies, request: IncomingMessage, response: ServerResponse, pathPrefix = ''): Promise<void> {
  const origin = request.headers.origin
  if (!allowedOrigin(origin)) {
    jsonResponse(response, 403, { error: 'ORIGIN_NOT_ALLOWED' })
    return
  }
  const rawUrl = request.url ?? '/'
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname
  const route = pathPrefix !== '' && pathname.startsWith(pathPrefix)
    ? (pathname.slice(pathPrefix.length) || '/')
    : pathname
  try {
    if (request.method === 'GET' && route === '/status') {
      const codex = await loadCodexCredential(dependencies.dshHome)
      const gemini = await dependencies.gemini.isAuthenticated()
      jsonResponse(response, 200, { codex: { authenticated: Boolean(codex?.accessToken && codex.refreshToken) }, gemini: { authenticated: gemini } }, origin)
      return
    }
    if (request.method === 'POST' && route === '/auth/codex/start') {
      jsonResponse(response, 200, await dependencies.codex.startCodexLogin(), origin)
      return
    }
    if (request.method === 'POST' && route === '/auth/codex/logout') {
      await dependencies.codex.logout()
      jsonResponse(response, 200, { ok: true }, origin)
      return
    }
    if (request.method === 'POST' && route === '/auth/gemini/start') {
      jsonResponse(response, 200, await dependencies.gemini.startGeminiLogin(), origin)
      return
    }
    if (request.method === 'POST' && route === '/auth/gemini/logout') {
      await dependencies.gemini.logout()
      jsonResponse(response, 200, { ok: true }, origin)
      return
    }
    jsonResponse(response, 404, { error: 'NOT_FOUND' }, origin)
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'OAUTH_BRIDGE_ERROR'
    jsonResponse(response, 500, { error: code }, origin)
  }
}

/**
 * Start the loopback control API used by the small OAuth status UI.
 *
 * @param dependencies - OAuth operations and local server configuration.
 * @returns the running server and an async disposer.
 */
export async function createControlServer(dependencies: ControlDependencies): Promise<{ server: Server; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleControlRequest(dependencies, request, response)
  })
  await listenControlServer(server, dependencies.port)
  return { server, close: () => closeControlServer(server) }
}

async function listenControlServer(server: Server, port: number): Promise<void> {
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
}

async function closeControlServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

/**
 * Mount the OAuth bridge into a DSH Cordis context.
 *
 * @param ctx - DSH context providing credentials and the LLM registry.
 * @param config - small plugin configuration surface.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const syncCodexRoute = createCodexRouteSync(ctx, config.dshHome)
  let syncGeminiRoute: (authenticated: boolean) => void
  const codex = createCodexService(ctx, { ...config, onAuthStateChange: syncCodexRoute })
  const gemini = createGeminiService(ctx, { ...config, onAuthStateChange: authenticated => syncGeminiRoute(authenticated) })
  const geminiAdapter = new GeminiCliAdapter(gemini)
  syncGeminiRoute = createGeminiRouteSync(ctx, geminiAdapter)
  void codex.initialize().catch(error => ctx.logger.warn(`Codex startup failed (${(error as { code?: string }).code ?? 'unknown'})`))
  void gemini.initialize().catch(error => ctx.logger.warn(`Gemini startup failed (${(error as { code?: string }).code ?? 'unknown'})`))
  const dependencies: ControlDependencies = { codex, gemini, dshHome: config.dshHome, port: config.controlPort ?? 1456 }
  const control = createControlServer(dependencies)
  void control.catch(error => ctx.logger.warn(`OAuth control server failed (${(error as { code?: string }).code ?? 'unknown'})`))
  // Same-origin carrier for browser clients: the desktop shell and plain Web
  // profiles expose the harness `webServer`; register the control API there so
  // the settings UI never has to cross origins (renderers block cross-port
  // loopback fetches). The standalone loopback server above stays as fallback.
  ctx.inject(['webServer'], webCtx => {
    const { webServer } = webCtx as Context & { webServer: WebServerFace }
    return webServer.register({
      kind: 'prefix',
      path: '/plugins/oauth-bridge',
      handler: (request, response) => {
        void handleControlRequest(dependencies, request, response, '/plugins/oauth-bridge')
      },
    })
  })
  void ctx.effect(function* () {
    yield async () => {
      await codex.dispose()
      await gemini.dispose()
      const running = await control
      await running.close()
    }
  }, name)
}

export { GeminiCliAdapter } from './gemini.js'
export { createCodexService } from './codex.js'
export { createGeminiService } from './gemini.js'
export * from './storage.js'
