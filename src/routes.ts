import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { loadCodexRouteOwnership, setCodexRouteOwnership } from './storage.js'

export const CODEX_PROVIDER = 'openai-codex'
export const GEMINI_PROVIDER = 'gemini-cli-oauth'

const PI_AI_NS = settingsNamespace('llm-pi-ai')
const CODEX_PROFILE = { apiKeyEnv: 'DSH_OPENAI_CODEX_TOKEN' } as const

interface CodexSettingsSnapshot {
  resolvedRoute: unknown
  userRoute: unknown
  revision: number
}

type CodexPathOperation =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one provider route from a resolved or raw llm-pi-ai section. */
function routeFromSection(section: unknown): unknown {
  if (!isRecord(section) || !isRecord(section.providers)) return undefined
  return section.providers[CODEX_PROVIDER]
}

/** Read both resolved and raw user route state before a fenced mutation. */
function readCodexSettings(ctx: Context): CodexSettingsSnapshot {
  const descriptor = ctx.settings.describe().find(entry => entry.ns === PI_AI_NS)
  if (descriptor === undefined) throw new Error('llm-pi-ai settings namespace is not registered')
  return {
    resolvedRoute: routeFromSection(descriptor.value),
    userRoute: routeFromSection(descriptor.user),
    revision: descriptor.revision,
  }
}

/** Check whether a raw user route is still exactly the profile created by this plugin. */
function isPluginRoute(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.apiKeyEnv === CODEX_PROFILE.apiKeyEnv
}

/**
 * Apply one Codex settings mutation with an optional revision fence.
 *
 * @param ctx - DSH context owning the settings provider.
 * @param operations - path operations to apply.
 * @param revision - settings revision read before the operation.
 */
async function mutateCodexSettings(ctx: Context, operations: readonly CodexPathOperation[], revision: number): Promise<void> {
  await ctx.settings.mutate(PI_AI_NS, operations, revision)
}

/**
 * Synchronize the Codex settings profile with its OAuth authentication state without taking ownership of user routes.
 *
 * @param ctx - DSH context owning the settings provider.
 * @param dshHome - optional DSH home used for the persisted ownership marker.
 * @returns an idempotent route synchronization function.
 */
export function createCodexRouteSync(ctx: Context, dshHome?: string): (authenticated: boolean) => Promise<void> {
  let current: boolean | undefined
  let ownsCodexRoute: boolean | undefined
  let mutation: Promise<void> = Promise.resolve()

  /** Apply one serialized Codex authentication transition. */
  async function synchronize(authenticated: boolean): Promise<void> {
    if (authenticated === current) return
    ownsCodexRoute ??= await loadCodexRouteOwnership(dshHome)
    const snapshot = readCodexSettings(ctx)

    if (!authenticated) {
      if (ownsCodexRoute && isPluginRoute(snapshot.userRoute)) {
        await mutateCodexSettings(ctx, [{ op: 'unset', path: ['providers', CODEX_PROVIDER] }], snapshot.revision)
      }
      if (ownsCodexRoute) await setCodexRouteOwnership(false, dshHome)
      ownsCodexRoute = false
      current = false
      return
    }

    if (snapshot.resolvedRoute !== undefined) {
      const stillOwnsRoute = ownsCodexRoute === true && isPluginRoute(snapshot.userRoute)
      if (ownsCodexRoute && !stillOwnsRoute) await setCodexRouteOwnership(false, dshHome)
      ownsCodexRoute = stillOwnsRoute
      current = true
      return
    }

    // Mark ownership before writing settings so a process crash cannot leave a newly-created route untraceable.
    await setCodexRouteOwnership(true, dshHome)
    try {
      await mutateCodexSettings(ctx, [{ op: 'set', path: ['providers', CODEX_PROVIDER], value: CODEX_PROFILE }], snapshot.revision)
    } catch (error) {
      await setCodexRouteOwnership(false, dshHome)
      throw error
    }
    ownsCodexRoute = true
    current = true
  }

  return function syncCodexRoute(authenticated: boolean): Promise<void> {
    const next = mutation.then(() => synchronize(authenticated), () => synchronize(authenticated))
    mutation = next.then(() => undefined, () => undefined)
    return next
  }
}

/**
 * Synchronize the Gemini adapter registration with its OAuth authentication state.
 *
 * @param ctx - DSH context owning the LLM registry.
 * @param adapter - Gemini adapter instance to expose when authenticated.
 * @returns an idempotent route synchronization function.
 */
export function createGeminiRouteSync(ctx: Context, adapter: LlmAdapter): (authenticated: boolean) => void {
  let registration: AdapterRegistrationHandle | undefined

  return function syncGeminiRoute(authenticated: boolean): void {
    if (registration === undefined) {
      if (!authenticated) return
      registration = ctx.llm.registerAdapter([GEMINI_PROVIDER], adapter)
      return
    }
    registration.replace(authenticated ? [GEMINI_PROVIDER] : [])
  }
}
