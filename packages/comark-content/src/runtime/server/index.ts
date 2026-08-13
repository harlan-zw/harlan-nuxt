import type { CollectionItem, CollectionName } from '../types'
import { createNavigation, createSearchSections, createSurroundings } from '../core/navigation'
import { createQueryBuilder, executeQueryPlan } from '../core/query'
import { loadCollection } from './storage'

export type { Collections, ContentNavigationItem, ContentSearchSection, PageCollectionItemBase, PageCollections, TocLink } from '../types'

export const queryCollection = <TName extends CollectionName | string>(_event: unknown, collection: TName) => createQueryBuilder<CollectionItem<TName>>(async plan => executeQueryPlan(await loadCollection(collection), plan) as CollectionItem<TName>[])

export const queryCollectionNavigation = async <TName extends CollectionName | string>(_event: unknown, collection: TName, fields: string[] = []) => createNavigation(await loadCollection(collection), fields)

export const queryCollectionItemSurroundings = async <TName extends CollectionName | string>(
  _event: unknown,
  collection: TName,
  path: string,
  options: { fields?: string[] } = {},
) => createSurroundings(await loadCollection(collection), path, options.fields)

export const queryCollectionSearchSections = async <TName extends CollectionName | string>(_event: unknown, collection: TName) => createSearchSections(await loadCollection(collection))
