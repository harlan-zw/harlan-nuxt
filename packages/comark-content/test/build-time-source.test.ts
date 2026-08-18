import type { PageCollectionItemBase } from '../src/runtime/types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }
import { createContentAssetPlan } from '../src/core/asset'
import { ingestCollections } from '../src/core/ingest'
import contentModule from '../src/module'
import queryRoute from '../src/runtime/server/api/query.post'
import { queryCollection, queryCollectionManifest, renderPageMarkdown } from '../src/runtime/server/index'
import { writeFixture } from './fixtures'
import { setTestContentAssets } from './nuxt-imports'

const temporaryRoots: string[] = []

const guide = [
  '---',
  'title: Install',
  'description: Install the module.',
  '---',
  '',
  '# Install',
  '',
  'Run the **install** command and read the [docs](/docs).',
  '',
  '```ts [nuxt.config.ts]',
  'export default defineNuxtConfig({ modules: [\'nuxt-og-image\'] })',
  '```',
  '',
  '::callout{type="info"}',
  'Nuxt 4 only.',
  '::',
  '',
  '| Option | Type |',
  '| --- | --- |',
  '| `debug` | boolean |',
  '',
].join('\n')

const changelog = ['---', 'title: Changelog', '---', '', '## 1.0.0', '', 'First release.', ''].join('\n')

async function generatedSite() {
  const root = await mkdtemp(join(tmpdir(), 'comark-content-build-time-'))
  temporaryRoots.push(root)
  await writeFixture(root, 'docs/install.md', guide)
  await writeFixture(root, 'notes/changelog.md', changelog)
  const result = await ingestCollections(
    [
      { name: 'docs', rootDir: root, definition: { type: 'page', source: { include: '**/*.md', cwd: join(root, 'docs') } } },
      { name: 'notes', rootDir: root, definition: { type: 'page', source: { include: '**/*.md', cwd: join(root, 'notes') }, sitemap: false } },
    ],
    { cacheFile: join(root, 'cache.json'), highlight: true },
  )
  if (result._tag === 'Err')
    throw new Error(result.error.message)
  const plan = createContentAssetPlan({ collections: result.value.collections, sitemapCollections: ['docs'] })
  setTestContentAssets(plan.assets.map(asset => [asset.path, asset.data] as [string, Uint8Array]))
  return Object.values(result.value.collections).flat().map(item => item.path)
}

/** What the /__comark_content/query endpoint sends back over the wire. */
async function queryOverTheWire(collection: string, path: string) {
  const handler = queryRoute as unknown as (event: unknown) => Promise<PageCollectionItemBase[]>
  const rows = await handler({
    _body: { _tag: 'Query', collection, plan: { operations: [{ _tag: 'Path', value: path }, { _tag: 'Limit', value: 1 }] } },
  })
  return JSON.parse(JSON.stringify(rows))[0] as PageCollectionItemBase | undefined
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('build time page source', () => {
  it('reports its own version so a consumer can fence on it', async () => {
    // getNuxtModuleVersion() returns false without this, so every
    // hasNuxtModuleCompatibility() check fails closed and silently.
    await expect(contentModule.getMeta?.()).resolves.toMatchObject({ version: packageJson.version })
  })

  it('reads every route in process and matches the query endpoint payload', async () => {
    const routes = await generatedSite()
    const manifest = await queryCollectionManifest()

    expect(manifest).toEqual([{ name: 'docs', sitemap: true }, { name: 'notes', sitemap: false }])
    expect(routes).toEqual(['/install', '/changelog'])

    for (const route of routes) {
      let direct: PageCollectionItemBase | null = null
      let wire: PageCollectionItemBase | undefined
      for (const { name } of manifest) {
        direct = await queryCollection(null, name).path(route).first() as PageCollectionItemBase | null
        if (!direct)
          continue
        wire = await queryOverTheWire(name, route)
        break
      }
      expect(direct, route).not.toBeNull()
      expect(wire, route).toEqual(direct)
      await expect(renderPageMarkdown(wire!.body)).resolves.toBe(await renderPageMarkdown(direct!.body))
    }
  })

  it('renders authored markdown back from a highlighted body', async () => {
    await generatedSite()
    const page = await queryCollection(null, 'docs').path('/install').first() as PageCollectionItemBase

    const markdown = await renderPageMarkdown(page.body)

    expect(markdown).toBe([
      '# Install',
      '',
      'Run the **install** command and read the [docs](/docs).',
      '',
      '```ts [nuxt.config.ts]',
      'export default defineNuxtConfig({ modules: [\'nuxt-og-image\'] })',
      '```',
      '',
      '::callout{type="info"}',
      'Nuxt 4 only.',
      '::',
      '',
      '| Option  | Type    |',
      '| ------- | ------- |',
      '| `debug` | boolean |',
    ].join('\n'))
  })

  it('adds the page frontmatter only when asked', async () => {
    await generatedSite()
    const page = await queryCollection(null, 'docs').path('/install').first() as PageCollectionItemBase

    await expect(renderPageMarkdown(page.body, { frontmatter: true })).resolves.toMatch(/^---\ntitle: Install\n/)
    await expect(renderPageMarkdown(page.body)).resolves.not.toMatch(/^---/)
  })
})
