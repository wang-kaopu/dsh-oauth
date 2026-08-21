import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearCodexCredential,
  clearGeminiCredential,
  loadDocument,
  loadGeminiCredential,
  saveCodexCredential,
  saveGeminiCredential,
  setCodexRouteOwnership,
  type CodexCredential,
} from '../src/storage.js'

async function testHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-oauth-storage-'))
}

const codex: CodexCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 60_000,
  accountId: 'account',
}

describe('storage', () => {
  it('saves and loads credentials atomically', async () => {
    const home = await testHome()
    await saveCodexCredential(codex, home)
    expect((await loadDocument(home)).codex).toEqual(codex)
    const source = await readFile(join(home, 'oauth-bridge.json'), 'utf8')
    expect(JSON.parse(source)).toEqual({ version: 1, codex })
  })

  it('keeps the old Gemini refresh token when a refresh response omits one', async () => {
    const home = await testHome()
    await saveGeminiCredential({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }, home)
    const old = await loadGeminiCredential(home)
    await saveGeminiCredential({ ...old!, accessToken: 'new-access', expiresAt: 2 }, home)
    expect(await loadGeminiCredential(home)).toEqual({ accessToken: 'new-access', refreshToken: 'old-refresh', expiresAt: 2 })
  })

  it('clears each provider independently', async () => {
    const home = await testHome()
    await saveCodexCredential(codex, home)
    await saveGeminiCredential({ refreshToken: 'refresh' }, home)
    await clearCodexCredential(home)
    expect((await loadDocument(home)).codex).toBeUndefined()
    await clearGeminiCredential(home)
    expect(await loadDocument(home)).toEqual({ version: 1 })
  })

  it('preserves Codex route ownership while clearing credentials', async () => {
    const home = await testHome()
    await saveCodexCredential(codex, home)
    await saveGeminiCredential({ refreshToken: 'refresh' }, home)
    await setCodexRouteOwnership(true, home)

    await clearCodexCredential(home)
    expect(await loadDocument(home)).toEqual({ version: 1, codexRouteOwned: true, gemini: { refreshToken: 'refresh' } })

    await clearGeminiCredential(home)
    expect(await loadDocument(home)).toEqual({ version: 1, codexRouteOwned: true })
  })

  it('reports malformed JSON explicitly', async () => {
    const home = await testHome()
    await writeFile(join(home, 'oauth-bridge.json'), '{broken')
    await expect(loadDocument(home)).rejects.toMatchObject({ code: 'OAUTH_BRIDGE_INVALID_JSON' })
  })
})
