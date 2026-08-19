import type { CollectionDefinition } from './config'
import type { PageCollectionItemBase } from './runtime/types'

export interface ContentHookFile extends Record<string, unknown> {
  id: string
  body: string
  path: string
  dirname: string
  extension: '.md'
  collectionType: 'page'
}

export interface ContentHookCollection {
  name: string
  type: 'page'
  tableName: string
  private: false
  source: CollectionDefinition['source']
  fields: Record<string, 'string' | 'number' | 'boolean' | 'date' | 'json'>
  indexes: CollectionDefinition['indexes']
}

export interface FileBeforeParseHook {
  file: ContentHookFile
  collection: ContentHookCollection
  parserOptions: {
    pathMeta: { forceLeadingSlash: true }
    markdown: {
      compress: false
      mdc: false
      toc: { depth: 3, searchDepth: 3 }
      tags: Record<string, string>
      remarkPlugins: Record<string, never>
      rehypePlugins: Record<string, never>
    }
  }
}

export interface FileAfterParseHook {
  file: ContentHookFile
  content: ContentHookPage
  collection: ContentHookCollection
}

export interface ContentHookPage extends PageCollectionItemBase {
  rawbody: string
}

export interface ContentHook {
  beforeParse?: (context: FileBeforeParseHook) => void | Promise<void>
  afterParse?: (context: FileAfterParseHook) => void | Promise<void>
}

function fieldType(value: unknown): ContentHookCollection['fields'][string] {
  if (typeof value === 'string')
    return 'string'
  if (typeof value === 'number')
    return 'number'
  if (typeof value === 'boolean')
    return 'boolean'
  return 'json'
}

export function contentHookCollection(name: string, definition: CollectionDefinition, content: Record<string, unknown> = {}): ContentHookCollection {
  return {
    name,
    type: 'page',
    tableName: `_content_${name}`,
    private: false,
    source: definition.source,
    fields: Object.fromEntries(Object.entries(content).map(([key, value]) => [key, fieldType(value)])),
    indexes: definition.indexes,
  }
}

export function contentHookFile(id: string, path: string, body: string): ContentHookFile {
  return {
    id,
    body,
    path,
    dirname: path.slice(0, Math.max(0, path.lastIndexOf('/'))),
    extension: '.md',
    collectionType: 'page',
  }
}

export function parserOptions(): FileBeforeParseHook['parserOptions'] {
  return {
    pathMeta: { forceLeadingSlash: true },
    markdown: {
      compress: false,
      mdc: false,
      toc: { depth: 3, searchDepth: 3 },
      tags: {},
      remarkPlugins: {},
      rehypePlugins: {},
    },
  }
}

declare module '@nuxt/schema' {
  interface NuxtHooks {
    'content:file:beforeParse': (context: FileBeforeParseHook) => void | Promise<void>
    'content:file:afterParse': (context: FileAfterParseHook) => void | Promise<void>
  }
}
