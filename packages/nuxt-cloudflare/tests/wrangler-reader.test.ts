import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectWranglerConfig } from '../src/wrangler-reader'

describe('readProjectWranglerConfig', () => {
  it('follows Nitro generated deploy config from the requested project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-'))
    await mkdir(join(root, '.wrangler/deploy'), { recursive: true })
    await mkdir(join(root, '.output/server'), { recursive: true })
    await writeFile(join(root, '.wrangler/deploy/config.json'), JSON.stringify({
      configPath: '../../.output/server/wrangler.json',
    }))
    await writeFile(join(root, '.output/server/wrangler.json'), JSON.stringify({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
    }))

    try {
      const loaded = readProjectWranglerConfig({ cwd: root })

      expect(loaded.path).toBe(join(root, '.output/server/wrangler.json'))
      expect(loaded.config.compatibility_date).toBe('2026-08-11')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
