import type { CollectionItem, CollectionName } from '../types'
import { renderPageMarkdown } from '../core/markdown'
import { createNavigation, createSurroundings } from '../core/navigation'
import { createQueryBuilder, executeIndexedQueryPlan } from '../core/query'
import { loadCollectionIndex, loadCollectionManifest, loadDocumentBody, loadNavigationCollection, loadSearchSections } from './storage'

export type { RenderPageMarkdownOptions } from '../core/markdown'
export type { Collections, ContentCollectionManifestEntry, ContentNavigationItem, ContentSearchSection, PageCollectionItemBase, PageCollections, TocLink } from '../types'
export { renderPageMarkdown }

/**
 * Every collection the build generated, with its sitemap opt out.
 *
 * Build-time consumers need this to walk collections without hard coding names.
 */
export const queryCollectionManifest = async (_event?: unknown) => loadCollectionManifest()

export function queryCollection<TName extends CollectionName | string>(_event: unknown, collection: TName) {
  return createQueryBuilder<CollectionItem<TName>>(async plan => executeIndexedQueryPlan(
    await loadCollectionIndex(collection),
    plan,
    asset => loadDocumentBody(collection, asset),
  ) as Promise<CollectionItem<TName>[]>)
}

export const queryCollectionNavigation = async <TName extends CollectionName | string>(_event: unknown, collection: TName, fields: string[] = []) => createNavigation(await loadNavigationCollection(collection), fields)

export async function queryCollectionItemSurroundings<TName extends CollectionName | string>(_event: unknown, collection: TName, path: string, options: { fields?: string[] } = {}) {
  return createSurroundings(await loadNavigationCollection(collection), path, options.fields)
}

export const queryCollectionSearchSections = async <TName extends CollectionName | string>(_event: unknown, collection: TName) => loadSearchSections(collection)
