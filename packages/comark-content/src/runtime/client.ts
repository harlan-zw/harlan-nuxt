import type { CollectionItem, CollectionName, ContentNavigationItem, ContentSearchSection } from './types'
import type { QueryRequest } from './shared/protocol'
import { createQueryBuilder } from './core/query'

type Fetch = <T>(path: string, options:
  | { method: 'POST', body: QueryRequest }
  | { method: 'GET', query: { fields: string } }
) => Promise<T>

const request = <T>(body: QueryRequest): Promise<T> => (globalThis as typeof globalThis & { $fetch: Fetch }).$fetch<T>('/__comark_content/query', {
  method: 'POST',
  body,
})

export const queryCollection = <TName extends CollectionName | string>(collection: TName) => createQueryBuilder<CollectionItem<TName>>(plan => request({ _tag: 'Query', collection, plan }))

export const queryCollectionNavigation = <TName extends CollectionName | string>(collection: TName, fields: string[] = []) => (globalThis as typeof globalThis & { $fetch: Fetch }).$fetch<ContentNavigationItem[]>(
  `/__comark_content/navigation/${encodeURIComponent(collection)}`,
  { method: 'GET', query: { fields: fields.join(',') } },
)

export const queryCollectionItemSurroundings = <TName extends CollectionName | string>(
  collection: TName,
  path: string,
  options: { fields?: string[] } = {},
) => request<[ContentNavigationItem | null, ContentNavigationItem | null]>({
  _tag: 'Surroundings',
  collection,
  path,
  fields: options.fields ?? [],
})

export const queryCollectionSearchSections = <TName extends CollectionName | string>(collection: TName) => request<ContentSearchSection[]>({
  _tag: 'SearchSections',
  collection,
})
