import { useStorage } from '#comark-content/storage'
import { createContentStorage } from './storage-core'

// Nitro replaces this expression during the server build.
// eslint-disable-next-line node/prefer-global/process
const isDevelopment = process.env.NODE_ENV === 'development'

const storage = createContentStorage(
  path => useStorage('assets:comark-content').getItemRaw(path),
  {
    cache: isDevelopment ? { _tag: 'Disabled' } : { _tag: 'Bounded' },
    immutableAssets: !isDevelopment,
  },
)

export const loadCollection = storage.loadCollection
export const loadCollectionIndex = storage.loadCollectionIndex
export const loadCollectionManifest = storage.loadCollectionManifest
export const loadDocumentBody = storage.loadDocumentBody
export const loadNavigationCollection = storage.loadNavigationCollection
export const loadSearchSections = storage.loadSearchSections
