import type { ContentCollectionManifestEntry, ContentSearchSection, IndexedContentDocument, NavigationCollectionItem, PageCollectionItemBase } from '../runtime/types'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createNavigationSource, createSearchSections } from '../runtime/core/navigation'

export const encodeCollectionAsset = (value: unknown): Uint8Array => gzipSync(JSON.stringify(value), { level: 9 })

export interface GeneratedContentAsset {
  path: string
  data: Uint8Array
}

export interface ContentAssetPlan {
  manifest: ContentCollectionManifestEntry[]
  assets: GeneratedContentAsset[]
}

export interface ContentAssetPlanInput {
  collections: Record<string, PageCollectionItemBase[]>
  /** Names of the collections the sitemap includes. */
  sitemapCollections: readonly string[]
}

const bodyAssetName = (id: string) => `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json.gz`

function canonicalContent(collections: Record<string, PageCollectionItemBase[]>) {
  return JSON.stringify(collections, (key, value) => {
    if (key === '_source')
      return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return value
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]))
  })
}

/**
 * Hashes the parsed content only.
 * The application build is excluded, so a redeploy keeps serving live clients.
 */
export function createContentRevision(collections: Record<string, PageCollectionItemBase[]>) {
  return createHash('sha256')
    .update('comark-content-assets-v1\0')
    .update(canonicalContent(collections))
    .digest('hex')
}

export function projectCollectionAssets(name: string, items: PageCollectionItemBase[]): GeneratedContentAsset[] {
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

export function createContentAssetPlan(input: ContentAssetPlanInput): ContentAssetPlan {
  const sitemapCollections = new Set(input.sitemapCollections)
  const manifest = Object.keys(input.collections).map(name => ({ name, sitemap: sitemapCollections.has(name) }))
  return {
    manifest,
    assets: [
      { path: 'collections.json.gz', data: encodeCollectionAsset(manifest) },
      ...Object.entries(input.collections).flatMap(([name, items]) => projectCollectionAssets(name, items)),
    ],
  }
}
