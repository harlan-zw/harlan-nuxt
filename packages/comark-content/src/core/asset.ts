import type { ContentCollectionManifestEntry, ContentSearchSection, IndexedContentDocument, NavigationCollectionItem, PageCollectionItemBase } from '../runtime/types'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

/** The asset every generated directory holds, whatever the collections are. */
const CONTENT_MANIFEST_ASSET = 'collections.json.gz'

const bodyAssetName = (id: string) => `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json.gz`

function isSorted(keys: string[]) {
  for (let index = 1; index < keys.length; index++) {
    if (keys[index - 1]! > keys[index]!)
      return false
  }
  return true
}

function canonicalContent(collections: Record<string, PageCollectionItemBase[]>) {
  return JSON.stringify(collections, (key, value) => {
    if (key === '_source')
      return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return value
    const keys = Object.keys(value)
    // Most parsed nodes already carry sorted keys. Reordering them allocates a
    // replacement object for every node in the tree, so only pay for it when the
    // order actually differs.
    if (isSorted(keys))
      return value
    return Object.fromEntries(keys.sort().map(name => [name, value[name]]))
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
      { path: CONTENT_MANIFEST_ASSET, data: encodeCollectionAsset(manifest) },
      ...Object.entries(input.collections).flatMap(([name, items]) => projectCollectionAssets(name, items)),
    ],
  }
}

/** Names the file that records which revision the generated directory holds. */
export const contentAssetStampPath = (outputDir: string): string => `${outputDir}.revision`

/**
 * The generated directory already held this revision, so no asset was rewritten.
 * A `Written` result means the directory was cleared and rebuilt.
 */
export type ContentAssetSync
  = | { _tag: 'Reused' }
    | { _tag: 'Written', assets: number }

export interface SyncContentAssetsOptions {
  outputDir: string
  /** Identifies the content the generated directory must hold. */
  revision: string
  /** Set to false to always rewrite, whatever the stamp says. */
  reuseUnchanged: boolean
  createPlan: () => ContentAssetPlan
}

/**
 * Writes the generated assets unless the directory already holds this revision.
 * The stamp is written last, so an interrupted write always rebuilds.
 */
export async function syncContentAssets(options: SyncContentAssetsOptions): Promise<ContentAssetSync> {
  const stampFile = contentAssetStampPath(options.outputDir)
  if (options.reuseUnchanged) {
    const stamp = await readFile(stampFile, 'utf8').catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error))
    // The stamp sits outside the generated directory, so it survives a wipe of
    // that directory. Check the manifest as well before trusting it.
    if (stamp === options.revision && existsSync(join(options.outputDir, CONTENT_MANIFEST_ASSET)))
      return { _tag: 'Reused' }
  }
  await rm(stampFile, { force: true })
  const plan = options.createPlan()
  await rm(options.outputDir, { recursive: true, force: true })
  await mkdir(options.outputDir, { recursive: true })
  await Promise.all(plan.assets.map(async (asset) => {
    const path = join(options.outputDir, asset.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, asset.data)
  }))
  await writeFile(stampFile, options.revision)
  return { _tag: 'Written', assets: plan.assets.length }
}
