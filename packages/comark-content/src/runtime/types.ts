import type { MarkdownDocument, Node } from 'comark'
import type { TocLink } from 'comark/plugins/toc'

export type { MarkdownDocument, Node, TocLink }
export type MarkdownRoot = MarkdownDocument
export type MinimarkNode = Node

export interface PageCollectionItemBase {
  id: string
  path: string
  stem: string
  extension: 'md'
  title: string
  description: string
  layout?: string
  prose?: boolean
  breadcrumbs?: boolean
  icon?: string
  image?: string
  publishedAt?: string
  updatedAt?: string
  keywords?: string[]
  relatedPages?: Array<{ path: string, title: string }>
  tags?: string[]
  new?: boolean
  deprecated?: boolean
  readTime?: string | number
  body: MarkdownDocument<{ toc: { links: TocLink[] }, title?: string, description?: string }> & { toc: { links: TocLink[] } }
  navigation?: boolean | string | Record<string, unknown>
  seo?: Record<string, unknown>
  _source: string
  [key: string]: unknown
}

export interface ContentCollectionManifestEntry {
  name: string
  sitemap: boolean
}

export interface ContentDocumentMetadata {
  id: string
  path: string
  stem: string
  extension: 'md'
  title: string
  description: string
  navigation?: PageCollectionItemBase['navigation']
  publishedAt?: string
  updatedAt?: string
  seo?: Record<string, unknown>
  _source: string
  [key: string]: unknown
}

export interface IndexedContentDocument<TItem extends PageCollectionItemBase = PageCollectionItemBase> {
  metadata: ContentDocumentMetadata & Omit<TItem, 'body'>
  bodyAsset: string
}

export interface NavigationCollectionItem {
  path: string
  stem: string
  title: string
  description: string
  navigation?: PageCollectionItemBase['navigation']
  [key: string]: unknown
}

export interface PageCollections {}
export interface Collections extends PageCollections {}

export type CollectionName = keyof Collections & string
export type CollectionItem<TName extends string> = TName extends keyof Collections
  ? Collections[TName]
  : PageCollectionItemBase

export interface ContentNavigationItem {
  title: string
  path: string
  children?: ContentNavigationItem[]
  [key: string]: unknown
}

export interface ContentSearchSection {
  id: string
  title: string
  titles: string[]
  content: string
  level: number
}

export interface SourceLocation {
  source: string
  line: number
  column: number
}

export type ContentError = SourceLocation & {
  _tag: 'ParseError' | 'SchemaError' | 'SourceError' | 'UnsupportedFeatureError'
  message: string
  cause?: unknown
}

export type Result<T, E = ContentError>
  = | { _tag: 'Ok', value: T }
    | { _tag: 'Err', error: E }
