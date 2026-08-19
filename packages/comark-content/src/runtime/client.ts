import type { QueryRequest } from './shared/protocol'
import type { CollectionItem, CollectionName, ContentNavigationItem, ContentSearchSection } from './types'
import { useRuntimeConfig } from '#imports'
import { createQueryBuilder } from './core/query'

type Fetch = <T>(path: string, options:
  | { method: 'POST', body: QueryRequest }
  | { method: 'GET', query: Record<string, string> }) => Promise<T>

function request<T>(body: QueryRequest): Promise<T> {
  return (globalThis as typeof globalThis & { $fetch: Fetch }).$fetch<T>('/__comark_content/query', {
    method: 'POST',
    body,
  })
}

function contentGetPath(resource: string, collection: string) {
  const revision = useRuntimeConfig().public.comarkContentRevision
  if (typeof revision !== 'string' || !revision)
    throw new TypeError('comark-content:1:1 The content revision is unavailable.')
  return `/__comark_content/${encodeURIComponent(revision)}/${resource}/${encodeURIComponent(collection)}`
}

export const queryCollection = <TName extends CollectionName | string>(collection: TName) => createQueryBuilder<CollectionItem<TName>>(plan => request({ _tag: 'Query', collection, plan }))

export function queryCollectionNavigation<TName extends CollectionName | string>(collection: TName, fields: string[] = []) {
  return (globalThis as typeof globalThis & { $fetch: Fetch }).$fetch<ContentNavigationItem[]>(
    contentGetPath('navigation', collection),
    { method: 'GET', query: { fields: fields.join(',') } },
  )
}

export function queryCollectionItemSurroundings<TName extends CollectionName | string>(collection: TName, path: string, options: { fields?: string[] } = {}) {
  return (globalThis as typeof globalThis & { $fetch: Fetch }).$fetch<[ContentNavigationItem | null, ContentNavigationItem | null]>(
    contentGetPath('surroundings', collection),
    { method: 'GET', query: { path, fields: (options.fields ?? []).join(',') } },
  )
}

export function queryCollectionSearchSections<TName extends CollectionName | string>(collection: TName) {
  return (globalThis as typeof globalThis & { $fetch: Fetch }).$fetch<ContentSearchSection[]>(
    contentGetPath('search', collection),
    { method: 'GET', query: {} },
  )
}
