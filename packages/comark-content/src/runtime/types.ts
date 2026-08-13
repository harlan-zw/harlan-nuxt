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
  rawbody: string
  layout?: string
  prose?: boolean
  breadcrumbs?: boolean
  h1?: boolean
  wide?: boolean
  icon?: string
  image?: string
  status?: string
  publishedAt?: string
  updatedAt?: string
  keywords?: string[]
  relatedPages?: Array<{ path: string, title: string }>
  newsletter?: boolean
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

export type SourceLocation = {
  source: string
  line: number
  column: number
}

export type ContentError = SourceLocation & {
  _tag: 'ParseError' | 'SchemaError' | 'SourceError' | 'UnsupportedFeatureError'
  message: string
  cause?: unknown
}

export type Result<T, E = ContentError> =
  | { _tag: 'Ok', value: T }
  | { _tag: 'Err', error: E }
