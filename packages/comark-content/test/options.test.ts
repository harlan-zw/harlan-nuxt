import { describe, expect, it } from 'vitest'
import { assertSupportedOptions, defineCollection } from '../src/config'
import { contentComponentDirectories } from '../src/components'
import { runContentBuild } from '../src/build'

describe('configuration boundary', () => {
  it('finds unprefixed content component directories in layer priority order', () => {
    expect(contentComponentDirectories([
      { config: { srcDir: '/site', dir: { app: 'app' } } },
      { config: { srcDir: '/layer', dir: { app: 'application' } } },
    ])).toEqual([
      '/layer/application/components/content',
      '/layer/components/content',
      '/site/app/components/content',
      '/site/components/content',
    ])
  })

  it('refreshes generated templates after content tags become available', async () => {
    const calls: string[] = []
    await runContentBuild(
      async () => { calls.push('ingest') },
      async () => { calls.push('templates') },
    )
    expect(calls).toEqual(['ingest', 'templates'])
  })

  it('rejects non-Markdown data collections', () => {
    expect(() => defineCollection({ type: 'data' as 'page', source: '**/*.json' })).toThrow('Markdown page collections are the only supported collection type')
  })

  it('reports database configuration as unsupported at its source', () => {
    expect(() => assertSupportedOptions({ database: { type: 'd1' } }, '/site/nuxt.config.ts')).toThrow('/site/nuxt.config.ts:1:1')
  })
})
