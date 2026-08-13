import { describe, expect, it } from 'vitest'
import { assertSupportedOptions, defineCollection } from '../src/config'
import { addUnprefixedContentAliases, contentComponentDirectories, renderComponentManifest } from '../src/components'

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

  it('renders discovered tags from the completed component scan', () => {
    expect(renderComponentManifest(
      new Set(['project-list', 'post-list']),
      [
        { pascalName: 'ProjectList', filePath: '/site/app/components/content/ProjectList.vue' },
        { pascalName: 'PostList', filePath: '/site/app/components/content/PostList.vue' },
      ],
      '/site/.nuxt/comark-content',
    )).toContain('"project-list": { name: "ProjectList"')
  })

  it('renders content components before Markdown ingestion completes', () => {
    const manifest = renderComponentManifest(
      new Set(),
      [
        { pascalName: 'ContentPostList', filePath: '/site/app/components/content/PostList.vue' },
        { pascalName: 'ProseA', filePath: '/ui/runtime/components/prose/A.vue' },
      ],
      '/site/.nuxt/comark-content',
    )

    expect(manifest).toContain('"postlist": { name: "ContentPostList"')
    expect(manifest).toContain('"a": { name: "ProseA"')
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

  it('reports database configuration as unsupported at its source', () => {
    expect(() => assertSupportedOptions({ database: { type: 'd1' } }, '/site/nuxt.config.ts')).toThrow('/site/nuxt.config.ts:1:1')
  })
})
