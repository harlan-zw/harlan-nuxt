import { describe, expect, it } from 'vitest'
import type { PageCollectionItemBase } from '../src/runtime/types'
import { createContentAssetPlan, encodeCollectionAsset } from '../src/core/asset'
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
    const plan = createContentAssetPlan({ pages })
    const assets = new Map(plan.assets.map(asset => [asset.path, asset.data]))
    const index = await decodeCollectionAsset<Array<{ metadata: Record<string, unknown>, bodyAsset: string }>>(assets.get('pages/index.json.gz')!, 'pages/index')
    const navigation = await decodeCollectionAsset<Array<Record<string, unknown>>>(assets.get('pages/navigation.json.gz')!, 'pages/navigation')
    const search = await decodeCollectionAsset<Array<Record<string, unknown>>>(assets.get('pages/search.json.gz')!, 'pages/search')

    expect(plan.collectionNames).toEqual(['pages'])
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

  it('filters metadata before loading only matched document bodies', async () => {
    const plan = createContentAssetPlan({ pages })
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
    const plan = createContentAssetPlan({ pages })
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
    const plan = createContentAssetPlan({ pages })
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
    const plan = createContentAssetPlan({ pages })
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
