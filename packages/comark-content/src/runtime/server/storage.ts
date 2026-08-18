import { useStorage } from '#imports'
import { createContentStorage } from './storage-core'

const storage = createContentStorage(path => useStorage('assets:comark-content').getItemRaw(path))

export const loadCollection = storage.loadCollection
export const loadCollectionIndex = storage.loadCollectionIndex
export const loadCollectionManifest = storage.loadCollectionManifest
export const loadDocumentBody = storage.loadDocumentBody
export const loadNavigationCollection = storage.loadNavigationCollection
export const loadSearchSections = storage.loadSearchSections
