import type { PageCollectionItemBase } from '../src/runtime/types'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentAssetStampPath, createContentAssetPlan, createContentRevision, encodeCollectionAsset, syncContentAssets } from '../src/core/asset'
import { createIndexedCollectionQuery } from '../src/runtime/core/query'
import { decodeCollectionAsset } from '../src/runtime/server/asset'
import { createContentStorage } from '../src/runtime/server/storage-core'

const body: PageCollectionItemBase['body'] = {
  frontmatter: {},
  meta: { toc: { links: [] } },
  toc: { links: [] },
  nodes: [['h1', { id: 'home' }, 'Home']],
}

const pages: PageCollectionItemBase[] = [
  { id: 'pages/index.md', path: '/', stem: 'index', extension: 'md', title: 'Home', description: 'Start', status: 'published', body, _source: '/content/index.md' },
  { id: 'pages/draft.md', path: '/draft', stem: 'draft', extension: 'md', title: 'Draft', description: '', status: 'draft', body: { ...body, nodes: [['h1', { id: 'draft' }, 'Draft']] }, _source: '/content/draft.md' },
]

describe('generated collection storage', () => {
  it('round trips collection items through the deployment asset codec', async () => {
    const collection = [{
      id: 'pages/index.md',
      path: '/',
      title: 'Home',
      body: { type: 'minimark', nodes: [['h1', { id: 'home' }, 'Home']] },
    }]

    await expect(decodeCollectionAsset(encodeCollectionAsset(collection), 'pages')).resolves.toEqual(collection)
  })

  it('identifies a malformed generated collection asset', async () => {
    await expect(decodeCollectionAsset(new Uint8Array([1, 2, 3]), 'pages')).rejects.toThrow('pages.json.gz:1:1')
  })

  it('projects metadata, navigation, search, and one body asset per document', async () => {
    const plan = createContentAssetPlan({ collections: { pages }, sitemapCollections: ['pages'] })
    const assets = new Map(plan.assets.map(asset => [asset.path, asset.data]))
    const index = await decodeCollectionAsset<Array<{ metadata: Record<string, unknown>, bodyAsset: string }>>(assets.get('pages/index.json.gz')!, 'pages/index')
    const navigation = await decodeCollectionAsset<Array<Record<string, unknown>>>(assets.get('pages/navigation.json.gz')!, 'pages/navigation')
    const search = await decodeCollectionAsset<Array<Record<string, unknown>>>(assets.get('pages/search.json.gz')!, 'pages/search')

    expect(plan.manifest).toEqual([{ name: 'pages', sitemap: true }])
    expect(index.map(item => item.metadata)).toEqual(pages.map(({ body: _body, ...metadata }) => metadata))
    expect(index.every(item => assets.has(`pages/body/${item.bodyAsset}`))).toBe(true)
    expect(navigation).toEqual([
      { path: '/', stem: 'index', title: 'Home', description: 'Start', status: 'published' },
      { path: '/draft', stem: 'draft', title: 'Draft', description: '', status: 'draft' },
    ])
    expect(search).toEqual([
      { id: '/#home', title: 'Home', titles: [], content: '', level: 1 },
      { id: '/draft#draft', title: 'Draft', titles: [], content: '', level: 1 },
    ])
  })

  it('changes the content revision only when a document changes', () => {
    const original = { pages }
    const changed = {
      pages: pages.map(page => page.path === '/draft'
        ? { ...page, body: { ...page.body, nodes: [['p', {}, 'Changed body.']] as PageCollectionItemBase['body']['nodes'] } }
        : page),
    }

    expect(createContentRevision(original)).toMatch(/^[a-f0-9]{64}$/)
    expect(createContentRevision({ pages })).toBe(createContentRevision(original))
    expect(createContentRevision({ empty: [], pages })).toBe(createContentRevision({ pages, empty: [] }))
    expect(createContentRevision({ pages: pages.map(page => ({ ...page, _source: `/other${page._source}` })) })).toBe(createContentRevision(original))
    expect(createContentRevision(changed)).not.toBe(createContentRevision(original))
  })

  it('keeps an opted out collection out of the sitemap manifest', async () => {
    const plan = createContentAssetPlan({ collections: { pages, snippets: [] }, sitemapCollections: ['pages'] })
    const assets = new Map(plan.assets.map(asset => [asset.path, asset.data]))
    const storage = createContentStorage(async path => assets.get(path) ?? null)

    await expect(storage.loadCollectionManifest()).resolves.toEqual([
      { name: 'pages', sitemap: true },
      { name: 'snippets', sitemap: false },
    ])
  })

  it('filters metadata before loading only matched document bodies', async () => {
    const plan = createContentAssetPlan({ collections: { pages }, sitemapCollections: ['pages'] })
    const assets = new Map(plan.assets.map(asset => [asset.path, asset.data]))
    const storage = createContentStorage(async path => assets.get(path) ?? null)
    const index = await storage.loadCollectionIndex('pages')
    const loaded: string[] = []

    const result = await createIndexedCollectionQuery(index, async (bodyAsset) => {
      loaded.push(bodyAsset)
      return storage.loadDocumentBody('pages', bodyAsset)
    }).where('status', '=', 'published').first()

    expect(result).toEqual(pages[0])
    expect(loaded).toEqual([index[0]!.bodyAsset])
  })

  it('returns selected metadata without loading a document body', async () => {
    const plan = createContentAssetPlan({ collections: { pages }, sitemapCollections: ['pages'] })
    const assets = new Map(plan.assets.map(asset => [asset.path, asset.data]))
    const storage = createContentStorage(async path => assets.get(path) ?? null)
    const index = await storage.loadCollectionIndex('pages')
    const loadBody = async (): Promise<PageCollectionItemBase['body']> => {
      throw new Error('Body should not load.')
    }

    await expect(createIndexedCollectionQuery(index, loadBody).select('path', 'title').all()).resolves.toEqual([
      { path: '/draft', title: 'Draft' },
      { path: '/', title: 'Home' },
    ])
  })

  it('decompresses matched document bodies one at a time', async () => {
    const plan = createContentAssetPlan({ collections: { pages }, sitemapCollections: ['pages'] })
    const assets = new Map(plan.assets.map(asset => [asset.path, asset.data]))
    const storage = createContentStorage(async path => assets.get(path) ?? null)
    const index = await storage.loadCollectionIndex('pages')
    let active = 0
    let maximumActive = 0

    await createIndexedCollectionQuery(index, async (bodyAsset) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      const result = await storage.loadDocumentBody('pages', bodyAsset)
      active -= 1
      return result
    }).all()

    expect(maximumActive).toBe(1)
  })

  it('loads compact navigation and precomputed search without document bodies', async () => {
    const plan = createContentAssetPlan({ collections: { pages }, sitemapCollections: ['pages'] })
    const assets = new Map(plan.assets.map(asset => [asset.path, asset.data]))
    const reads: string[] = []
    const storage = createContentStorage(async (path) => {
      reads.push(path)
      return assets.get(path) ?? null
    })

    await expect(storage.loadNavigationCollection('pages')).resolves.toHaveLength(2)
    await expect(storage.loadSearchSections('pages')).resolves.toHaveLength(2)
    expect(reads).toEqual(['pages/navigation.json.gz', 'pages/search.json.gz'])
  })
})

describe('generated asset synchronisation', () => {
  const temporaryRoots: string[] = []

  const temporaryOutputDir = async () => {
    const root = await mkdtemp(join(tmpdir(), 'comark-content-assets-'))
    temporaryRoots.push(root)
    return join(root, 'generated')
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  const planFor = (items: PageCollectionItemBase[]) => () => createContentAssetPlan({ collections: { pages: items }, sitemapCollections: ['pages'] })

  it('writes every asset when the generated directory holds another revision', async () => {
    const outputDir = await temporaryOutputDir()
    const createPlan = vi.fn(planFor(pages))

    const first = await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: true, createPlan })
    const second = await syncContentAssets({ outputDir, revision: 'two', reuseUnchanged: true, createPlan })

    expect(first).toEqual({ _tag: 'Written', assets: 6 })
    expect(second).toEqual({ _tag: 'Written', assets: 6 })
    expect(createPlan).toHaveBeenCalledTimes(2)
    await expect(readFile(contentAssetStampPath(outputDir), 'utf8')).resolves.toBe('two')
  })

  it('skips the plan when the generated directory already holds the revision', async () => {
    const outputDir = await temporaryOutputDir()
    const createPlan = vi.fn(planFor(pages))

    await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: true, createPlan })
    const reused = await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: true, createPlan })

    expect(reused).toEqual({ _tag: 'Reused' })
    expect(createPlan).toHaveBeenCalledTimes(1)
  })

  it('rewrites when the generated directory is gone but the stamp survives', async () => {
    const outputDir = await temporaryOutputDir()
    const createPlan = vi.fn(planFor(pages))

    await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: true, createPlan })
    await rm(outputDir, { recursive: true, force: true })
    const rebuilt = await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: true, createPlan })

    expect(rebuilt).toEqual({ _tag: 'Written', assets: 6 })
    await expect(readdir(outputDir)).resolves.toContain('collections.json.gz')
  })

  it('rewrites when the caller opts out of reuse', async () => {
    const outputDir = await temporaryOutputDir()
    const createPlan = vi.fn(planFor(pages))

    await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: true, createPlan })
    const rewritten = await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: false, createPlan })

    expect(rewritten).toEqual({ _tag: 'Written', assets: 6 })
    expect(createPlan).toHaveBeenCalledTimes(2)
  })

  it('leaves no stamp behind when the write fails part way', async () => {
    const outputDir = await temporaryOutputDir()

    await syncContentAssets({ outputDir, revision: 'one', reuseUnchanged: true, createPlan: planFor(pages) })
    await expect(syncContentAssets({
      outputDir,
      revision: 'two',
      reuseUnchanged: true,
      createPlan: () => { throw new Error('plan failed') },
    })).rejects.toThrow('plan failed')

    await expect(readFile(contentAssetStampPath(outputDir), 'utf8')).rejects.toThrow('ENOENT')
  })

  it('drops assets of a collection the build no longer produces', async () => {
    const outputDir = await temporaryOutputDir()

    await syncContentAssets({
      outputDir,
      revision: 'one',
      reuseUnchanged: true,
      createPlan: () => createContentAssetPlan({ collections: { pages, notes: pages }, sitemapCollections: ['pages'] }),
    })
    await syncContentAssets({ outputDir, revision: 'two', reuseUnchanged: true, createPlan: planFor(pages) })

    await expect(readdir(outputDir)).resolves.toEqual(['collections.json.gz', 'pages'])
  })
})
