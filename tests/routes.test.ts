import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCodexRouteSync, createGeminiRouteSync } from '../src/routes.js'

function llmContext() {
  const replace = vi.fn()
  const registerAdapter = vi.fn(() => Object.assign(vi.fn(), { replace }))
  return { llm: { registerAdapter }, registerAdapter, replace }
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-oauth-routes-'))
}

describe('OAuth route synchronization', () => {
  it('does not register Gemini before authentication and replaces its route on logout', () => {
    const context = llmContext()
    const sync = createGeminiRouteSync(context as never, {} as never)

    sync(false)
    expect(context.registerAdapter).not.toHaveBeenCalled()
    sync(true)
    expect(context.registerAdapter).toHaveBeenCalledWith(['gemini-cli-oauth'], {})
    sync(false)
    expect(context.replace).toHaveBeenCalledWith([])
    sync(true)
    expect(context.replace).toHaveBeenCalledWith(['gemini-cli-oauth'])
  })

  it('creates and removes only the Codex profile owned by the plugin', async () => {
    const dshHome = await home()
    let settingsSection: Record<string, unknown> = { providers: {} }
    let userSection: Record<string, unknown> = { providers: {} }
    let revision = 0
    const mutate = vi.fn(async (_namespace: string, operations: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[]) => {
      for (const operation of operations) {
        const providers = settingsSection.providers as Record<string, unknown>
        const userProviders = userSection.providers as Record<string, unknown>
        if (operation.op === 'set') {
          providers['openai-codex'] = operation.value
          userProviders['openai-codex'] = operation.value
        } else {
          delete providers['openai-codex']
          delete userProviders['openai-codex']
        }
      }
      revision += 1
    })
    const context = { settings: { describe: vi.fn(() => [{ ns: 'llm-pi-ai', value: settingsSection, user: userSection, revision }]), mutate } }
    const sync = createCodexRouteSync(context as never, dshHome)

    await sync(true)
    expect(mutate).toHaveBeenLastCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: { apiKeyEnv: 'DSH_OPENAI_CODEX_TOKEN' } }], 0)
    await sync(false)
    expect(mutate).toHaveBeenLastCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'openai-codex'] }], 1)
    await sync(false)
    expect(mutate).toHaveBeenCalledTimes(2)
  })

  it('preserves a user-owned Codex profile and a plugin route later edited by the user', async () => {
    const dshHome = await home()
    const userProfile = { apiKeyEnv: 'MY_CODEX_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 2 } }
    const mutate = vi.fn(async () => undefined)
    const context = { settings: {
      describe: vi.fn(() => [{ ns: 'llm-pi-ai', value: { providers: { 'openai-codex': userProfile } }, user: { providers: { 'openai-codex': userProfile } }, revision: 0 }]),
      mutate,
    } }
    const sync = createCodexRouteSync(context as never, dshHome)

    await sync(true)
    await sync(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps a plugin-created route after the user adds their own settings', async () => {
    const dshHome = await home()
    let route: unknown
    let revision = 0
    const mutate = vi.fn(async (_namespace: string, operations: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[]) => {
      route = operations[0]?.op === 'set' ? operations[0].value : undefined
      revision += 1
    })
    const context = { settings: {
      describe: vi.fn(() => [{ ns: 'llm-pi-ai', value: { providers: route === undefined ? {} : { 'openai-codex': route } }, user: { providers: route === undefined ? {} : { 'openai-codex': route } }, revision }]),
      mutate,
    } }
    await createCodexRouteSync(context as never, dshHome)(true)
    route = { apiKeyEnv: 'DSH_OPENAI_CODEX_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 2 } }

    await createCodexRouteSync(context as never, dshHome)(false)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(route).toEqual({ apiKeyEnv: 'DSH_OPENAI_CODEX_TOKEN', retryPolicy: { mode: 'normal', maxRetries: 2 } })
  })

  it('does not mutate when the llm-pi-ai settings namespace is unavailable', async () => {
    const dshHome = await home()
    const mutate = vi.fn(async () => undefined)
    const context = { settings: { describe: vi.fn(() => []), mutate } }
    const sync = createCodexRouteSync(context as never, dshHome)

    await expect(sync(true)).rejects.toThrow('llm-pi-ai settings namespace is not registered')
    expect(mutate).not.toHaveBeenCalled()
  })
})
