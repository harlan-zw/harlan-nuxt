import { access, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
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
    let path: string | undefined
    const result = await withWorkerSecretsFile({
      secrets: { API_TOKEN: 'secret', OLD_TOKEN: null },
      use: async (secretsPath) => {
        path = secretsPath
        expect(JSON.parse(await readFile(secretsPath, 'utf8'))).toEqual({ API_TOKEN: 'secret', OLD_TOKEN: null })
        expect((await stat(secretsPath)).mode & 0o777).toBe(0o600)
        expect((await stat(dirname(secretsPath))).mode & 0o777).toBe(0o700)
        return 'deployed'
      },
    })

    expect(result).toBe('deployed')
    expect(path).toBeDefined()
    await expect(access(path!)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(dirname(path!))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the secrets directory when deployment fails', async () => {
    let path: string | undefined
    const failure = new Error('deployment failed')

    await expect(withWorkerSecretsFile({
      secrets: { API_TOKEN: 'secret' },
      use: (secretsPath) => {
        path = secretsPath
        throw failure
      },
    })).rejects.toBe(failure)
    expect(path).toBeDefined()
    await expect(access(dirname(path!))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not call deployment when serialization fails', async () => {
    const failure = new Error('serialization failed')
    const secrets = Object.defineProperty({}, 'API_TOKEN', {
      enumerable: true,
      get: () => {
        throw failure
      },
    }) as Record<string, string>

    await expect(withWorkerSecretsFile({
      secrets,
      use: () => undefined,
    })).rejects.toBe(failure)
  })
})
