import { describe, expect, it } from 'vitest'
import { addUnprefixedContentAliases, contentComponentDirectories, localizeNuxtUiProseComponents, selectContentComponents } from '../src/components'
import { assertCloudflareCacheModule, assertSupportedOptions, defineCollection, mergeCollectionSources } from '../src/config'
import { isMarkdownWatchEvent } from '../src/core/source'

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

  it('selects only components used by the ingested AST', () => {
    const selected = selectContentComponents(
      new Set(['a', 'card', 'lazy-chart-streaming-comparison', 'span']),
      [
        { pascalName: 'ProseA', filePath: '/ui/runtime/components/prose/A.vue' },
        { pascalName: 'Card', filePath: '/ui/runtime/components/Card.vue' },
        { pascalName: 'ProseCard', filePath: '/ui/runtime/components/prose/Card.vue' },
        { pascalName: 'ContentChartStreamingComparison', filePath: '/site/app/components/content/ChartStreamingComparison.vue' },
        { pascalName: 'ContentUnused', filePath: '/site/app/components/content/Unused.vue' },
      ],
    )

    expect(selected.map(entry => [entry.tag, entry.component.pascalName])).toEqual([
      ['a', 'ProseA'],
      ['card', 'ProseCard'],
      ['lazy-chart-streaming-comparison', 'ContentChartStreamingComparison'],
    ])
  })

  it('keeps Nuxt UI prose components out of the global registry', () => {
    const components = localizeNuxtUiProseComponents([
      { pascalName: 'ProseA', filePath: '/app/node_modules/@nuxt/ui/dist/runtime/components/prose/A.vue', global: true },
      { pascalName: 'ContentPostList', filePath: '/site/app/components/content/PostList.vue', global: true },
    ])

    expect(components.map(component => [component.pascalName, component.global])).toEqual([
      ['ProseA', false],
      ['ContentPostList', true],
    ])
  })

  it('preserves Content aliases while adding native names', () => {
    const components = addUnprefixedContentAliases([
      {
        pascalName: 'ContentPostMeta',
        kebabName: 'content-post-meta',
        export: 'default',
        filePath: '/site/app/components/content/PostMeta.vue',
        shortPath: 'content/PostMeta.vue',
        chunkName: 'components/content-post-meta',
        prefetch: false,
        preload: false,
      },
    ], ['/site/app/components/content'])

    expect(components.map(component => component.pascalName)).toEqual(['ContentPostMeta', 'PostMeta'])
  })

  it('rejects non-Markdown data collections', () => {
    expect(() => defineCollection({ type: 'data' as 'page', source: '**/*.json' })).toThrow('Markdown page collections are the only supported collection type')
  })

  it('accepts a glob that lists Markdown among its extensions', () => {
    expect(() => defineCollection({ type: 'page', source: '**/*.{md,yml}' })).not.toThrow()
    expect(() => defineCollection({ type: 'page', source: { include: '3.docs/**/*.{md,yml}' } })).not.toThrow()
    expect(() => defineCollection({ type: 'page', source: '**/*.md' })).not.toThrow()
    expect(() => defineCollection({ type: 'page', source: '**/*' })).not.toThrow()
    expect(() => defineCollection({ type: 'page', source: '**/*.{json,yml}' })).toThrow('Markdown files are the only supported collection source')
    expect(() => defineCollection({ type: 'page', source: '**/*.json' })).toThrow('Markdown files are the only supported collection source')
  })

  it('reports a collection name that two content configurations define', () => {
    expect(() => mergeCollectionSources([
      { configPath: '/site/content.config.ts', collections: { docs: defineCollection({ type: 'page' }) } },
      { configPath: '/layer/content.config.ts', collections: { docs: defineCollection({ type: 'page' }) } },
    ])).toThrow('/layer/content.config.ts:1:1 Collection "docs" is already defined in /site/content.config.ts')
  })

  it('keeps every uniquely named collection with its configuration directory', () => {
    expect(mergeCollectionSources([
      { configPath: '/site/content.config.ts', collections: { docs: defineCollection({ type: 'page' }) } },
      { configPath: '/layer/content.config.ts', collections: { blog: defineCollection({ type: 'page' }) } },
    ]).map(collection => [collection.name, collection.rootDir])).toEqual([
      ['docs', '/site'],
      ['blog', '/layer'],
    ])
  })

  it('rebuilds content when Markdown is added, changed, or deleted', () => {
    expect(isMarkdownWatchEvent('add', '/site/content/new.md')).toBe(true)
    expect(isMarkdownWatchEvent('change', '/site/content/new.md')).toBe(true)
    expect(isMarkdownWatchEvent('unlink', '/site/content/new.md')).toBe(true)
    expect(isMarkdownWatchEvent('addDir', '/site/content/guide')).toBe(false)
    expect(isMarkdownWatchEvent('change', '/site/app/app.vue')).toBe(false)
  })

  it('reports database configuration as unsupported at its source', () => {
    expect(() => assertSupportedOptions({ database: { type: 'd1' } }, '/site/nuxt.config.ts')).toThrow('/site/nuxt.config.ts:1:1')
  })

  it('requires nuxt-cloudflare when Content runs on Cloudflare', () => {
    expect(() => assertCloudflareCacheModule({ preset: 'cloudflare-module', moduleInstalled: false }, '/site/nuxt.config.ts')).toThrow(
      '/site/nuxt.config.ts:1:1 Cloudflare deployments require @harlan-zw/nuxt-cloudflare',
    )
    expect(() => assertCloudflareCacheModule({ preset: 'cloudflare-durable', moduleInstalled: true, workersCache: { enabled: false } }, '/site/nuxt.config.ts')).toThrow(
      '/site/nuxt.config.ts:1:1 Cloudflare deployments require Workers Caching',
    )
    expect(() => assertCloudflareCacheModule({ preset: 'cloudflare-durable', moduleInstalled: true, workersCache: { enabled: true } }, '/site/nuxt.config.ts')).not.toThrow()
    expect(() => assertCloudflareCacheModule({ preset: 'node-server', moduleInstalled: false }, '/site/nuxt.config.ts')).not.toThrow()
  })
})
