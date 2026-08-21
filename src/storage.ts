import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface CodexCredential {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
  accountId: string
}

export interface GeminiCredential {
  accessToken?: string
  refreshToken: string
  expiresAt?: number
  projectId?: string
}

export interface CredentialDocument {
  version: 1
  codex?: CodexCredential
  gemini?: GeminiCredential
  codexRouteOwned?: true
}

const CREDENTIAL_FILENAME = 'oauth-bridge.json'

function credentialPath(dshHome?: string): string {
  return dshHome === undefined ? dshHomePath(CREDENTIAL_FILENAME) : join(resolveDshHome(dshHome), CREDENTIAL_FILENAME)
}

function invalidDocument(message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string }
  error.code = 'OAUTH_BRIDGE_INVALID_JSON'
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateCredentialDocument(value: unknown): CredentialDocument {
  if (!isRecord(value) || value.version !== 1) throw invalidDocument('oauth-bridge.json must contain version 1')
  if (value.codex !== undefined && !isRecord(value.codex)) throw invalidDocument('oauth-bridge.json codex credential is invalid')
  if (value.gemini !== undefined && !isRecord(value.gemini)) throw invalidDocument('oauth-bridge.json gemini credential is invalid')
  if (value.codexRouteOwned !== undefined && value.codexRouteOwned !== true) throw invalidDocument('oauth-bridge.json codex route ownership is invalid')
  return value as unknown as CredentialDocument
}

async function readDocument(path: string): Promise<CredentialDocument> {
  try {
    const source = await readFile(path, 'utf8')
    try {
      return validateCredentialDocument(JSON.parse(source) as unknown)
    } catch (error) {
      if ((error as { code?: string }).code === 'OAUTH_BRIDGE_INVALID_JSON') throw error
      throw invalidDocument('oauth-bridge.json contains malformed JSON', error)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }
    throw error
  }
}

async function updateDocument(dshHome: string | undefined, update: (document: CredentialDocument) => CredentialDocument): Promise<void> {
  const path = credentialPath(dshHome)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const next = validateCredentialDocument(update(await readDocument(path)))
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Read whether the Codex settings route was created by this plugin.
 *
 * @param dshHome - optional explicit DSH home used by tests or an embedding host.
 * @returns true only when the ownership marker is present.
 */
export async function loadCodexRouteOwnership(dshHome?: string): Promise<boolean> {
  return (await loadDocument(dshHome)).codexRouteOwned === true
}

/**
 * Persist or clear the Codex settings route ownership marker.
 *
 * @param owned - whether the plugin currently owns the route it created.
 * @param dshHome - optional explicit DSH home used by tests or an embedding host.
 */
export async function setCodexRouteOwnership(owned: boolean, dshHome?: string): Promise<void> {
  await updateDocument(dshHome, document => {
    if (owned) return { ...document, codexRouteOwned: true }
    const { codexRouteOwned: _removed, ...rest } = document
    return rest
  })
}

/**
 * Load the complete OAuth credential document.
 *
 * @param dshHome - optional explicit DSH home used by tests or an embedding host.
 * @returns the stored document, or an empty version-one document when absent.
 */
export async function loadDocument(dshHome?: string): Promise<CredentialDocument> {
  return readDocument(credentialPath(dshHome))
}

/**
 * Atomically replace the complete OAuth credential document.
 *
 * @param document - document to persist.
 * @param dshHome - optional explicit DSH home.
 */
export async function saveDocument(document: CredentialDocument, dshHome?: string): Promise<void> {
  await updateDocument(dshHome, () => validateCredentialDocument(document))
}

/**
 * Load the stored Codex credential.
 *
 * @param dshHome - optional explicit DSH home.
 * @returns the Codex credential, if authenticated.
 */
export async function loadCodexCredential(dshHome?: string): Promise<CodexCredential | undefined> {
  return (await loadDocument(dshHome)).codex
}

/**
 * Save the Codex credential without disturbing the Gemini credential.
 *
 * @param credential - refreshed or newly exchanged Codex credential.
 * @param dshHome - optional explicit DSH home.
 */
export async function saveCodexCredential(credential: CodexCredential, dshHome?: string): Promise<void> {
  await updateDocument(dshHome, document => ({ ...document, codex: credential }))
}

/**
 * Remove the Codex credential.
 *
 * @param dshHome - optional explicit DSH home.
 */
export async function clearCodexCredential(dshHome?: string): Promise<void> {
  await updateDocument(dshHome, ({ gemini, codexRouteOwned }) => ({ version: 1, ...(codexRouteOwned === true ? { codexRouteOwned: true as const } : {}), ...(gemini === undefined ? {} : { gemini }) }))
}

/**
 * Load the stored Gemini credential.
 *
 * @param dshHome - optional explicit DSH home.
 * @returns the Gemini credential, if authenticated.
 */
export async function loadGeminiCredential(dshHome?: string): Promise<GeminiCredential | undefined> {
  return (await loadDocument(dshHome)).gemini
}

/**
 * Save the Gemini credential without disturbing the Codex credential.
 *
 * @param credential - OAuth or Code Assist credential to persist.
 * @param dshHome - optional explicit DSH home.
 */
export async function saveGeminiCredential(credential: GeminiCredential, dshHome?: string): Promise<void> {
  await updateDocument(dshHome, document => ({ ...document, gemini: credential }))
}

/**
 * Remove the Gemini credential.
 *
 * @param dshHome - optional explicit DSH home.
 */
export async function clearGeminiCredential(dshHome?: string): Promise<void> {
  await updateDocument(dshHome, ({ codex, codexRouteOwned }) => ({ version: 1, ...(codexRouteOwned === true ? { codexRouteOwned: true as const } : {}), ...(codex === undefined ? {} : { codex }) }))
}
