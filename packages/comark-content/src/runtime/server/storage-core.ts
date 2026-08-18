import type { ContentCollectionManifestEntry, ContentSearchSection, IndexedContentDocument, NavigationCollectionItem, PageCollectionItemBase } from '../types'
import { decodeCollectionAsset } from './asset'

export type ContentAssetReader = (path: string) => Promise<Uint8Array | null | undefined>

const collectionName = /^[A-Z]\w*$/i
const bodyAssetName = /^[a-f0-9]{32}\.json\.gz$/

function assertCollectionName(name: string) {
  if (!collectionName.test(name))
    throw new TypeError(`<request>:1:1 Invalid collection name "${name}".`)
}

export function createContentStorage(readAsset: ContentAssetReader) {
  const loadAsset = async <T>(path: string, missingMessage: string): Promise<T> => {
    const value = await readAsset(`${path}.json.gz`)
    if (!value)
      throw new TypeError(missingMessage)
    return decodeCollectionAsset<T>(value, path)
  }
  const loadCollectionIndex = (name: string): Promise<IndexedContentDocument[]> => {
    assertCollectionName(name)
    return loadAsset(`${name}/index`, `<request>:1:1 Unknown collection "${name}".`)
  }
  const loadNavigationCollection = (name: string): Promise<NavigationCollectionItem[]> => {
    assertCollectionName(name)
    return loadAsset(`${name}/navigation`, `<request>:1:1 Unknown collection "${name}".`)
  }
  const loadSearchSections = (name: string): Promise<ContentSearchSection[]> => {
    assertCollectionName(name)
    return loadAsset(`${name}/search`, `<request>:1:1 Unknown collection "${name}".`)
  }
  const loadDocumentBody = (name: string, asset: string): Promise<PageCollectionItemBase['body']> => {
    assertCollectionName(name)
    if (!bodyAssetName.test(asset))
      throw new TypeError(`<request>:1:1 Invalid Markdown body reference "${asset}".`)
    return loadAsset(`${name}/body/${asset.slice(0, -'.json.gz'.length)}`, `<request>:1:1 Missing generated Markdown body "${asset}".`)
  }
  const loadCollection = async (name: string): Promise<PageCollectionItemBase[]> => {
    const index = await loadCollectionIndex(name)
    const items: PageCollectionItemBase[] = []
    for (const item of index)
      items.push({ ...item.metadata, body: await loadDocumentBody(name, item.bodyAsset) })
    return items
  }
  const loadCollectionManifest = () => loadAsset<ContentCollectionManifestEntry[]>('collections', '<request>:1:1 Missing generated collection metadata.')
  return { loadCollection, loadCollectionIndex, loadCollectionManifest, loadDocumentBody, loadNavigationCollection, loadSearchSections }
}
