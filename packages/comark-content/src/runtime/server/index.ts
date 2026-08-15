import type { CollectionItem, CollectionName } from '../types'
import { createNavigation, createSurroundings } from '../core/navigation'
import { createQueryBuilder, executeIndexedQueryPlan } from '../core/query'
import { loadCollectionIndex, loadDocumentBody, loadNavigationCollection, loadSearchSections } from './storage'

export type { Collections, ContentNavigationItem, ContentSearchSection, PageCollectionItemBase, PageCollections, TocLink } from '../types'

export const queryCollection = <TName extends CollectionName | string>(_event: unknown, collection: TName) => createQueryBuilder<CollectionItem<TName>>(async plan => executeIndexedQueryPlan(
  await loadCollectionIndex(collection),
  plan,
  asset => loadDocumentBody(collection, asset),
) as Promise<CollectionItem<TName>[]>)

export const queryCollectionNavigation = async <TName extends CollectionName | string>(_event: unknown, collection: TName, fields: string[] = []) => createNavigation(await loadNavigationCollection(collection), fields)

export const queryCollectionItemSurroundings = async <TName extends CollectionName | string>(
  _event: unknown,
  collection: TName,
  path: string,
  options: { fields?: string[] } = {},
) => createSurroundings(await loadNavigationCollection(collection), path, options.fields)

export const queryCollectionSearchSections = async <TName extends CollectionName | string>(_event: unknown, collection: TName) => loadSearchSections(collection)
