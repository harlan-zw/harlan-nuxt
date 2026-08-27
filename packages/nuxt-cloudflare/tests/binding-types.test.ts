import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareCloudflareBindingTypes } from '../src/binding-types'

describe('prepareCloudflareBindingTypes', () => {
  it('gives reordered Wrangler vars and ProcessEnv keys the same signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-binding-types-'))
    const common = {
      cacheDir: false as const,
      compatibilityDate: '2026-08-11',
      nodeCompat: true,
      rootDir: root,
    }

    try {
      const prepared = await prepareCloudflareBindingTypes({
        ...common,
        buildDir: join(root, 'prepared'),
        wrangler: {
          vars: {
            NUXT_PUBLIC_BASE_URL: 'https://gscdump.com',
            BING_INDEXING_PREVIEW_ALLOWLIST: '',
            ICEBERG_R2_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
            OVERLAY_CATALOG_ENABLED: 'true',
          },
        },
      })
      const final = await prepareCloudflareBindingTypes({
        ...common,
        buildDir: join(root, 'final'),
        wrangler: {
          vars: {
            ICEBERG_R2_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
            OVERLAY_CATALOG_ENABLED: 'true',
            NUXT_PUBLIC_BASE_URL: 'https://gscdump.com',
            BING_INDEXING_PREVIEW_ALLOWLIST: '',
          },
        },
      })

      expect(prepared.signature).toBe(final.signature)
      expect(prepared.content).not.toContain(root)
      expect(final.content).not.toContain(root)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
