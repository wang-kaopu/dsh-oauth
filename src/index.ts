import type { Context } from '@deepseek-ai/cordis'
import { loadCodexCredential } from './storage.js'
import { createCodexService } from './codex.js'
import { createGeminiService, GeminiCliAdapter } from './gemini.js'
import { createServer, type Server } from 'node:http'

export interface Config {
  dshHome?: string
  controlPort?: number
  codexRedirectPort?: number
}

export const name = '@kelvinwww/dsh-oauth'
export const inject = ['credentials', 'llm'] as const

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

function jsonResponse(response: import('node:http').ServerResponse, status: number, value: unknown, origin?: string): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  })
  response.end(JSON.stringify(value))
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
 * Start the loopback control API used by the small OAuth status UI.
 *
 * @param dependencies - OAuth operations and local server configuration.
 * @returns the running server and an async disposer.
 */
export async function createControlServer(dependencies: ControlDependencies): Promise<{ server: Server; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    if (!allowedOrigin(origin)) {
      jsonResponse(response, 403, { error: 'ORIGIN_NOT_ALLOWED' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        const codex = await loadCodexCredential(dependencies.dshHome)
        const gemini = await dependencies.gemini.isAuthenticated()
        jsonResponse(response, 200, { codex: { authenticated: Boolean(codex?.accessToken && codex.refreshToken) }, gemini: { authenticated: gemini } }, origin)
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/codex/start') {
        jsonResponse(response, 200, await dependencies.codex.startCodexLogin(), origin)
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/codex/logout') {
        await dependencies.codex.logout()
        jsonResponse(response, 200, { ok: true }, origin)
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/gemini/start') {
        jsonResponse(response, 200, await dependencies.gemini.startGeminiLogin(), origin)
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/gemini/logout') {
        await dependencies.gemini.logout()
        jsonResponse(response, 200, { ok: true }, origin)
        return
      }
      jsonResponse(response, 404, { error: 'NOT_FOUND' }, origin)
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'OAUTH_BRIDGE_ERROR'
      jsonResponse(response, 500, { error: code }, origin)
    }
  })
  await listenControlServer(server, dependencies.port)
  return { server, close: () => closeControlServer(server) }
}

/**
 * Mount the OAuth bridge into a DSH Cordis context.
 *
 * @param ctx - DSH context providing credentials and the LLM registry.
 * @param config - small plugin configuration surface.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const codex = createCodexService(ctx, config)
  const gemini = createGeminiService(ctx, config)
  ctx.llm.registerAdapter(['gemini-cli-oauth'], new GeminiCliAdapter(gemini))
  void codex.initialize().catch(error => ctx.logger.warn(`Codex startup failed (${(error as { code?: string }).code ?? 'unknown'})`))
  void gemini.initialize().catch(error => ctx.logger.warn(`Gemini startup failed (${(error as { code?: string }).code ?? 'unknown'})`))
  const control = createControlServer({ codex, gemini, dshHome: config.dshHome, port: config.controlPort ?? 1456 })
  void control.catch(error => ctx.logger.warn(`OAuth control server failed (${(error as { code?: string }).code ?? 'unknown'})`))
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
