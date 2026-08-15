import type { ContentSearchSection, IndexedContentDocument, NavigationCollectionItem, PageCollectionItemBase } from '../runtime/types'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createNavigationSource, createSearchSections } from '../runtime/core/navigation'

export const encodeCollectionAsset = (value: unknown): Uint8Array => gzipSync(JSON.stringify(value), { level: 9 })

export type GeneratedContentAsset = {
  path: string
  data: Uint8Array
}

export type ContentAssetPlan = {
  collectionNames: string[]
  assets: GeneratedContentAsset[]
}

const bodyAssetName = (id: string) => `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json.gz`

const canonicalContent = (collections: Record<string, PageCollectionItemBase[]>) => JSON.stringify(collections, (key, value) => {
  if (key === '_source')
    return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return value
  return Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]))
})

export const createContentRevision = (buildId: string, collections: Record<string, PageCollectionItemBase[]>) => createHash('sha256')
  .update('comark-content-assets-v1\0')
  .update(buildId)
  .update('\0')
  .update(canonicalContent(collections))
  .digest('hex')

export const projectCollectionAssets = (name: string, items: PageCollectionItemBase[]): GeneratedContentAsset[] => {
  const index: IndexedContentDocument[] = []
  const navigation: NavigationCollectionItem[] = []
  const bodyAssets: GeneratedContentAsset[] = []
  for (const item of items) {
    const { body, ...metadata } = item
    const bodyAsset = bodyAssetName(item.id)
    index.push({ metadata, bodyAsset })
    navigation.push(createNavigationSource(item))
    bodyAssets.push({ path: `${name}/body/${bodyAsset}`, data: encodeCollectionAsset(body) })
  }
  const search: ContentSearchSection[] = createSearchSections(items)
  return [
    { path: `${name}/index.json.gz`, data: encodeCollectionAsset(index) },
    { path: `${name}/navigation.json.gz`, data: encodeCollectionAsset(navigation) },
    { path: `${name}/search.json.gz`, data: encodeCollectionAsset(search) },
    ...bodyAssets,
  ]
}

export const createContentAssetPlan = (collections: Record<string, PageCollectionItemBase[]>): ContentAssetPlan => {
  const collectionNames = Object.keys(collections)
  return {
    collectionNames,
    assets: [
      { path: 'collections.json.gz', data: encodeCollectionAsset(collectionNames) },
      ...Object.entries(collections).flatMap(([name, items]) => projectCollectionAssets(name, items)),
    ],
  }
}
