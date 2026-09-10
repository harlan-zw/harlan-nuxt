import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diagnoseStaticAssetRules, readStaticAssetRuleFiles, resolveBuildStaticAssetDirectory, resolveConfigStaticAssetDirectory } from '../src/static-assets'

function headerRules(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}/page-${i}.md\n  Content-Type: text/markdown\n`).join('')
}

describe('diagnoseStaticAssetRules', () => {
  it('is quiet when every file is under its limit', () => {
    const diagnostics = diagnoseStaticAssetRules({
      headers: `# generated\n\n/*\n  X-Frame-Options: DENY\n${headerRules('/guide', 98)}`,
      redirects: '/old /new 301\n/blog/* /posts/:splat 302\n',
    })

    expect(diagnostics).toEqual([])
  })

  it('fails a _headers file over 100 rules and names the prefixes that fill it', () => {
    const diagnostics = diagnoseStaticAssetRules({
      headers: `/*\n  X-Frame-Options: DENY\n${headerRules('/guide', 60)}${headerRules('/learn', 45)}`,
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ _tag: 'error', code: 'static-headers-rule-limit', sourcePath: '_headers' })
    expect(diagnostics[0]!.message).toContain('106 rules')
    expect(diagnostics[0]!.message).toContain('/guide/* (60)')
    expect(diagnostics[0]!.message).toContain('/learn/* (45)')
  })

  it('counts static and dynamic redirects against their own limits', () => {
    const dynamic = Array.from({ length: 101 }, (_, i) => `/d${i}/* /x/:splat 301`).join('\n')
    const diagnostics = diagnoseStaticAssetRules({ redirects: `${dynamic}\n/one /two 301\n` })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ _tag: 'error', code: 'static-redirects-rule-limit', sourcePath: '_redirects' })
    expect(diagnostics[0]!.message).toContain('101 dynamic')
  })

  it('ignores comments and blank lines', () => {
    const diagnostics = diagnoseStaticAssetRules({
      headers: `# one\n\n${headerRules('/a', 100)}\n# trailing\n`,
      redirects: '# none\n\n',
    })

    expect(diagnostics).toEqual([])
  })
})

describe('readStaticAssetRuleFiles', () => {
  it('reads whichever files the directory carries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-assets-'))
    try {
      await writeFile(join(dir, '_headers'), '/*\n  X-A: 1\n')
      expect(readStaticAssetRuleFiles(dir)).toEqual({ headers: '/*\n  X-A: 1\n' })
      expect(readStaticAssetRuleFiles(join(dir, 'missing'))).toEqual({})
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})

describe('resolveBuildStaticAssetDirectory', () => {
  const output = { dir: '/site/.output', publicDir: '/site/.output/public' }

  it.each([
    ['cloudflare-module', '/site/.output/public'],
    ['cloudflare-durable', '/site/.output/public'],
    ['cloudflare_module', '/site/.output/public'],
    ['cloudflare-pages', '/site/.output'],
    ['cloudflare-pages-static', '/site/.output'],
    [undefined, '/site/.output/public'],
  ])('%s uploads from %s', (preset, expected) => {
    expect(resolveBuildStaticAssetDirectory(preset, output)).toBe(expected)
  })
})

describe('resolveConfigStaticAssetDirectory', () => {
  it('resolves a Worker assets directory against the config location', () => {
    expect(resolveConfigStaticAssetDirectory('/site/.output/server/wrangler.json', { assets: { directory: '../public' } }))
      .toBe('/site/.output/public')
  })

  it('resolves a Pages build output directory the same way', () => {
    expect(resolveConfigStaticAssetDirectory('/site/wrangler.jsonc', { pages_build_output_dir: './dist' }))
      .toBe('/site/dist')
  })

  it('has nothing to count when the config uploads no assets', () => {
    expect(resolveConfigStaticAssetDirectory('/site/wrangler.jsonc', {})).toBeUndefined()
    expect(resolveConfigStaticAssetDirectory(undefined, { assets: { directory: 'public' } })).toBeUndefined()
  })
})
