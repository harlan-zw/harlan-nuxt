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
    await mkdir(join(root, 'apps/site'), { recursive: true })
    await writeFile(join(root, '.wrangler/deploy/config.json'), JSON.stringify({
      configPath: '../../.output/server/wrangler.json',
    }))
    await writeFile(join(root, '.output/server/wrangler.json'), JSON.stringify({
      compatibility_date: '2026-08-11',
      compatibility_flags: ['nodejs_compat'],
    }))

    try {
      const loaded = readProjectWranglerConfig({ cwd: join(root, 'apps/site') })

      expect(loaded._tag).toBe('loaded')
      if (loaded._tag !== 'loaded')
        throw new Error(loaded.reason)
      expect(loaded.path).toBe(join(root, '.output/server/wrangler.json'))
      expect(loaded.config.compatibility_date).toBe('2026-08-11')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('returns an invalid artifact when a generated-config redirect is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-'))
    await mkdir(join(root, '.wrangler/deploy'), { recursive: true })
    await writeFile(join(root, '.wrangler/deploy/config.json'), JSON.stringify({
      configPath: '../../.output/server/wrangler.json',
    }))

    try {
      expect(readProjectWranglerConfig({ cwd: root })).toMatchObject({
        _tag: 'invalid',
        generated: true,
        path: join(root, '.output/server/wrangler.json'),
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('does not follow an ancestor deploy redirect across a nested project boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-'))
    await mkdir(join(root, '.wrangler/deploy'), { recursive: true })
    await mkdir(join(root, '.output/server'), { recursive: true })
    await mkdir(join(root, 'apps/site'), { recursive: true })
    await writeFile(join(root, '.wrangler/deploy/config.json'), JSON.stringify({
      configPath: '../../.output/server/wrangler.json',
    }))
    await writeFile(join(root, '.output/server/wrangler.json'), JSON.stringify({
      compatibility_date: '2025-01-01',
    }))
    await writeFile(join(root, 'apps/site/wrangler.jsonc'), JSON.stringify({
      compatibility_date: '2026-08-11',
    }))

    try {
      const loaded = readProjectWranglerConfig({ cwd: join(root, 'apps/site') })

      expect(loaded).toMatchObject({
        _tag: 'loaded',
        generated: false,
        path: join(root, 'apps/site/wrangler.jsonc'),
      })
      if (loaded._tag !== 'loaded')
        throw new Error(loaded.reason)
      expect(loaded.config.compatibility_date).toBe('2026-08-11')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
