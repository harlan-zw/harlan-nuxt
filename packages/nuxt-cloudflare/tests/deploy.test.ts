import { access, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkerSecrets, withWorkerSecretsFile } from '../src/deploy'

describe('resolveWorkerSecrets', () => {
  it('returns missing names without returning a partial secret payload', () => {
    expect(resolveWorkerSecrets(['API_TOKEN', 'SESSION_PASSWORD'], { API_TOKEN: 'present' })).toEqual({
      _tag: 'missing',
      names: ['SESSION_PASSWORD'],
    })
  })
})

describe('withWorkerSecretsFile', () => {
  it('scopes a mode-0600 JSON file to the deployment callback', async () => {
    const path = join(tmpdir(), `nuxt-cloudflare-secrets-${crypto.randomUUID()}.json`)
    const result = await withWorkerSecretsFile({
      path,
      secrets: { API_TOKEN: 'secret' },
      use: async (secretsPath) => {
        expect(secretsPath).toBe(path)
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ API_TOKEN: 'secret' })
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        return 'deployed'
      },
    })

    expect(result).toBe('deployed')
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the secrets file when deployment fails', async () => {
    const path = join(tmpdir(), `nuxt-cloudflare-secrets-${crypto.randomUUID()}.json`)
    const failure = new Error('deployment failed')

    await expect(withWorkerSecretsFile({
      path,
      secrets: { API_TOKEN: 'secret' },
      use: () => {
        throw failure
      },
    })).rejects.toBe(failure)
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not create a file when serialization fails', async () => {
    const path = join(tmpdir(), `nuxt-cloudflare-secrets-${crypto.randomUUID()}.json`)
    const failure = new Error('serialization failed')
    const secrets = Object.defineProperty({}, 'API_TOKEN', {
      enumerable: true,
      get: () => {
        throw failure
      },
    }) as Record<string, string>

    await expect(withWorkerSecretsFile({
      path,
      secrets,
      use: () => undefined,
    })).rejects.toBe(failure)
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
