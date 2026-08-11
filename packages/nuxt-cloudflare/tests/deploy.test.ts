import { readFile, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkerSecrets, writeWorkerSecretsFile } from '../src/deploy'

describe('resolveWorkerSecrets', () => {
  it('returns missing names without returning a partial secret payload', () => {
    expect(resolveWorkerSecrets(['API_TOKEN', 'SESSION_PASSWORD'], { API_TOKEN: 'present' })).toEqual({
      _tag: 'missing',
      names: ['SESSION_PASSWORD'],
    })
  })
})

describe('writeWorkerSecretsFile', () => {
  it('writes a mode-0600 JSON file for atomic wrangler deployment', async () => {
    const path = join(tmpdir(), `nuxt-cloudflare-secrets-${crypto.randomUUID()}.json`)
    const result = await writeWorkerSecretsFile(path, { API_TOKEN: 'secret' })

    expect(result).toEqual({ _tag: 'written', path })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ API_TOKEN: 'secret' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await unlink(path)
  })
})
