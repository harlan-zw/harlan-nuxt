import type { MarkdownDocument } from 'comark'
import type { CollectionDefinition, StandardSchemaIssue } from '../config'
import type { ContentHighlight } from '../highlight'
import type { PageCollectionItemBase, Result } from '../runtime/types'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createMarkdownParser } from 'comark'
import headings from 'comark/plugins/headings'
import toc from 'comark/plugins/toc'
import { collectComponentTags } from '../runtime/components/names'
import { generatedTitle } from '../runtime/core/path'
import { CACHE_VERSION, readCache, writeCache } from './cache'
import { contentPath, sourceStem } from './path'
import { prepareRemoteSource } from './remote'
import { err, ok, sourceError } from './result'
import { resolveCollectionSource, scanSource } from './source'

export type LoadedCollection = {
  name: string
  rootDir: string
  definition: CollectionDefinition
}

export type IngestionResult = {
  collections: Record<string, PageCollectionItemBase[]>
  parsedFiles: number
  cachedFiles: number
  componentTags: string[]
}

type IngestionOptions = {
  cacheFile: string
  remoteCacheDir?: string
  parse?: (source: string) => Promise<MarkdownDocument>
  highlight?: ContentHighlight
}

const plainParser = createMarkdownParser({
  plugins: [
    headings(),
    toc({ depth: 3, searchDepth: 3 }),
  ],
})

const highlightedParsers = new Map<string, Promise<(source: string) => Promise<MarkdownDocument>>>()

export const createContentParser = async (options: Pick<IngestionOptions, 'highlight'> = {}) => {
  if (!options.highlight)
    return plainParser
  const { highlightCacheKey, resolveShikiOptions } = await import('../highlight')
  const key = highlightCacheKey(options.highlight)
  const cached = highlightedParsers.get(key)
  if (cached)
    return cached
  const parser = Promise.all([
    import('comark/plugins/shiki'),
    resolveShikiOptions(options.highlight),
  ]).then(([{ default: shiki }, shikiOptions]) => createMarkdownParser({
    plugins: [
      headings(),
      toc({ depth: 3, searchDepth: 3 }),
      shiki(shikiOptions as Parameters<typeof shiki>[0]),
    ],
  }))
  highlightedParsers.set(key, parser)
  return parser
}

const errorLocation = (cause: unknown, markdown: string) => {
  if (!cause || typeof cause !== 'object')
    return { line: 1, column: 1 }
  const value = cause as Record<string, unknown>
  const mark = value.mark && typeof value.mark === 'object' ? value.mark as Record<string, unknown> : undefined
  const line = Number(mark?.line ?? value.lineNumber ?? value.line ?? 0)
  const column = Number(mark?.column ?? value.column ?? 0)
  return {
    line: Math.max(1, line + (mark ? markdown.startsWith('---\n') ? 2 : 1 : 0)),
    column: Math.max(1, column + (mark ? 1 : 0)),
  }
}

const issueKey = (issue: StandardSchemaIssue) => {
  const part = issue.path?.[0]
  if (typeof part === 'object' && part && 'key' in part)
    return String(part.key)
  return part === undefined ? undefined : String(part)
}

const frontmatterLocation = (source: string, issue: StandardSchemaIssue) => {
  const key = issueKey(issue)
  if (!key)
    return { line: 1, column: 1 }
  const line = source.split('\n').findIndex(value => new RegExp(`^\\s*${key.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(value))
  return { line: line === -1 ? 1 : line + 1, column: 1 }
}

const parseSchemaResult = (result: unknown) => {
  if (!result || typeof result !== 'object')
    return { value: result as Record<string, unknown> }
  const record = result as Record<string, unknown>
  return {
    value: record.value as Record<string, unknown> | undefined,
    issues: record.issues as StandardSchemaIssue[] | undefined,
  }
}

const applySchema = async (definition: CollectionDefinition, frontmatter: Record<string, unknown>) => {
  const validate = definition.schema?.['~standard']?.validate
  return validate ? parseSchemaResult(await validate(frontmatter)) : { value: frontmatter }
}

const digest = (source: string, parser: string) => createHash('sha256').update(CACHE_VERSION).update('\0').update(parser).update('\0').update(source).digest('hex')

export const ingestCollections = async (
  loadedCollections: LoadedCollection[],
  options: IngestionOptions,
): Promise<Result<IngestionResult>> => {
  const parse = options.parse ?? await createContentParser({ highlight: options.highlight })
  const cache = await readCache(options.cacheFile)
  const nextCache = { version: CACHE_VERSION, entries: {} as typeof cache.entries }
  const collections: Record<string, PageCollectionItemBase[]> = {}
  let parsedFiles = 0
  let cachedFiles = 0
  const componentTags = new Set<string>()

  for (const collection of loadedCollections) {
    const declaredSource = typeof collection.definition.source === 'object' ? collection.definition.source : undefined
    let remoteCwd: string | undefined
    if (declaredSource?.repository) {
      const remote = await prepareRemoteSource(
        { ...declaredSource, repository: declaredSource.repository },
        options.remoteCacheDir ?? `${options.cacheFile}.remote`,
      )
      if (remote._tag === 'Err')
        return remote
      remoteCwd = remote.value
    }
    const source = resolveCollectionSource(collection.definition, collection.rootDir, remoteCwd)
    let files: Awaited<ReturnType<typeof scanSource>>
    try {
      files = await scanSource(source)
    }
    catch (cause) {
      return err(sourceError('SourceError', source.cwd, 1, 1, 'Could not read the Markdown source.', cause))
    }
    const items: PageCollectionItemBase[] = []
    for (const file of files) {
      const markdown = await readFile(file.path, 'utf8')
      const checksum = digest(markdown, JSON.stringify(options.highlight ?? false))
      const cacheKey = `${collection.name}:${file.path}`
      let document: MarkdownDocument
      const cached = cache.entries[cacheKey]
      if (cached?.digest === checksum) {
        cachedFiles += 1
        document = cached.document
      }
      else {
        try {
          document = await parse(markdown)
        }
        catch (cause) {
          const location = errorLocation(cause, markdown)
          return err(sourceError('ParseError', file.path, location.line, location.column, 'Could not parse Markdown.', cause))
        }
        parsedFiles += 1
      }
      nextCache.entries[cacheKey] = { digest: checksum, document }
      const schema = await applySchema(collection.definition, document.frontmatter)
      const issue = schema.issues?.[0]
      if (issue) {
        const location = frontmatterLocation(markdown, issue)
        return err(sourceError('SchemaError', file.path, location.line, location.column, issue.message))
      }
      const frontmatter = { ...document.frontmatter, ...schema.value }
      for (const tag of collectComponentTags(document.nodes))
        componentTags.add(tag)
      const path = contentPath(file.key, source.prefix)
      const meta = document.meta as Record<string, unknown>
      items.push({
        id: `${collection.name}/${file.key}`,
        path,
        stem: sourceStem(file.key),
        extension: 'md',
        ...frontmatter,
        title: String(frontmatter.title ?? meta.title ?? generatedTitle(path)),
        description: String(frontmatter.description ?? meta.description ?? ''),
        rawbody: markdown,
        navigation: frontmatter.navigation as PageCollectionItemBase['navigation'],
        seo: {
          title: frontmatter.title ?? meta.title ?? generatedTitle(path),
          description: frontmatter.description ?? meta.description ?? '',
          ...(typeof frontmatter.seo === 'object' ? frontmatter.seo : {}),
        },
        body: { ...document, toc: (meta.toc ?? { links: [] }) } as PageCollectionItemBase['body'],
        _source: file.path,
      })
    }
    collections[collection.name] = items
  }
  await writeCache(options.cacheFile, nextCache)
  return ok({ collections, parsedFiles, cachedFiles, componentTags: [...componentTags].sort() })
}
