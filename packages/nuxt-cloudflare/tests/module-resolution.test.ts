import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('lets Nuxt module loaders use the public Wrangler helper', () => {
  const root = mkdtempSync(join(tmpdir(), 'nuxt-cloudflare-loader-'))
  writeFileSync(join(root, 'wrangler.jsonc'), '{}')
  const require = createRequire(import.meta.url)
  try {
    const { findProjectWranglerConfig } = require('@harlan-zw/nuxt-cloudflare/wrangler')
    expect(findProjectWranglerConfig(root)).toBe(join(root, 'wrangler.jsonc'))
  }
  finally {
    rmSync(root, { force: true, recursive: true })
  }
})
