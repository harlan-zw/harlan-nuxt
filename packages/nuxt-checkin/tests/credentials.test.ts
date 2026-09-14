import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readCheckCredential } from '../src/runtime/external'

it('uses runtime environment before ordered INI and dotenv fallback', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'check-credential-'))
  try {
    await writeFile(join(rootDir, '.sentryclirc'), '[other]\ntoken=wrong\n[auth]\ntoken=first\n')
    await writeFile(join(rootDir, '.env.sentry'), 'SENTRY_AUTH_TOKEN="second"\n')
    const source = { env: 'SENTRY_AUTH_TOKEN', files: [{ path: '.missing', key: 'token' }, { path: '.sentryclirc', section: 'auth', key: 'token' }, { path: '.env.sentry', key: 'SENTRY_AUTH_TOKEN' }] }
    expect(await readCheckCredential(source, { rootDir, env: { SENTRY_AUTH_TOKEN: 'environment' } })).toBe('environment')
    expect(await readCheckCredential(source, { rootDir, env: {} })).toBe('first')
    await rm(join(rootDir, '.sentryclirc'))
    expect(await readCheckCredential(source, { rootDir, env: {} })).toBe('second')
  }
  finally { await rm(rootDir, { recursive: true }) }
})
