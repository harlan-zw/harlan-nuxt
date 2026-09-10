import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diagnoseStaticAssetRules, readStaticAssetRuleFiles } from '../src/static-assets'

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
  it('reads each file from the first directory that holds it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-assets-'))
    try {
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public/_headers'), '/*\n  X-A: 1\n')
      await writeFile(join(dir, '_redirects'), '/old /new 301\n')

      expect(readStaticAssetRuleFiles([join(dir, 'public'), dir])).toEqual({
        headers: '/*\n  X-A: 1\n',
        redirects: '/old /new 301\n',
      })
      expect(readStaticAssetRuleFiles([join(dir, 'missing')])).toEqual({})
      expect(readStaticAssetRuleFiles([])).toEqual({})
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
