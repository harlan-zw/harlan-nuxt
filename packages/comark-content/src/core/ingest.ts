import type { MarkdownDocument } from 'comark'
import type { CollectionDefinition, StandardSchemaIssue } from '../config'
import type { ContentHighlight } from '../highlight'
import type { ContentHook, ContentHookPage } from '../hooks'
import type { PageCollectionItemBase, Result } from '../runtime/types'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createMarkdownParser } from 'comark'
import headings from 'comark/plugins/headings'
import rangi from 'comark/plugins/rangi'
import toc from 'comark/plugins/toc'
import { collectComponentTags } from '../runtime/components/names'
import { generatedTitle } from '../runtime/core/path'
import { CACHE_VERSION, readCache, writeCache } from './cache'
import { contentPath, sourceStem } from './path'
import { contentRangiLanguages, contentRangiTheme, normalizeRangiThemeVariables } from './rangi'
import { prepareRemoteSource } from './remote'
import { err, ok, sourceError } from './result'
import { resolveCollectionSource, scanSource } from './source'
import { contentHookCollection, contentHookFile, parserOptions } from '../hooks'

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

type IngestionOptions = ContentHook & {
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

export const createContentParser = async (
  options: Pick<IngestionOptions, 'highlight'> = {},
) => {
  if (!options.highlight)
    return plainParser
  const highlight = typeof options.highlight === 'object' ? options.highlight : {}
  const parse = createMarkdownParser({
    plugins: [
      headings(),
      toc({ depth: 3, searchDepth: 3 }),
      rangi({
        classPrefix: 'rangi',
        languages: { ...contentRangiLanguages, ...highlight.languages },
        lineNumbers: true,
        theme: highlight.theme ?? contentRangiTheme,
      }),
    ],
  })
  return async (source: string) => normalizeRangiThemeVariables(await parse(source))
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

const contentHighlightFingerprint = (highlight: ContentHighlight | undefined) => JSON.stringify(
  highlight ?? false,
  (_key, value) => value instanceof RegExp
    ? { _tag: 'RegExp', source: value.source, flags: value.flags }
    : value,
)

export const ingestCollections = async (
  loadedCollections: LoadedCollection[],
  options: IngestionOptions,
): Promise<Result<IngestionResult>> => {
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
    const sources = await Promise.all(files.map(file => readFile(file.path, 'utf8')))
    const preparedFiles = []
    for (const [index, file] of files.entries()) {
      const fileId = `${collection.name}/${file.key}`
      const hookFile = contentHookFile(fileId, file.path, sources[index] ?? '')
      const hookCollection = contentHookCollection(collection.name, collection.definition)
      await options.beforeParse?.({ file: hookFile, collection: hookCollection, parserOptions: parserOptions() })
      preparedFiles.push({ file, fileId, hookFile, hookCollection, markdown: hookFile.body })
    }
    const parse = options.parse ?? await createContentParser({ highlight: options.highlight })
    for (const { file, fileId, hookFile, hookCollection, markdown } of preparedFiles) {
      const checksum = digest(markdown, contentHighlightFingerprint(options.highlight))
      const cacheKey = `${collection.name}:${file.path}`
      let document: MarkdownDocument
      const cached = cache.entries[cacheKey]
      let parsed = false
      if (cached?.digest === checksum) {
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
        parsed = true
      }
      const schema = await applySchema(collection.definition, document.frontmatter)
      const issue = schema.issues?.[0]
      if (issue) {
        const location = frontmatterLocation(markdown, issue)
        return err(sourceError('SchemaError', file.path, location.line, location.column, issue.message))
      }
      const frontmatter = { ...document.frontmatter, ...schema.value }
      const path = contentPath(file.key, source.prefix)
      const meta = document.meta as Record<string, unknown>
      const item: ContentHookPage = {
        id: fileId,
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
      }
      const afterParse = { file: hookFile, content: item, collection: contentHookCollection(hookCollection.name, collection.definition, item) }
      await options.afterParse?.(afterParse)
      delete (afterParse.content as Partial<ContentHookPage>).rawbody
      nextCache.entries[cacheKey] = { digest: checksum, document }
      parsedFiles += Number(parsed)
      cachedFiles += Number(!parsed)
      for (const tag of collectComponentTags(document.nodes))
        componentTags.add(tag)
      items.push(afterParse.content)
    }
    collections[collection.name] = items
  }
  await writeCache(options.cacheFile, nextCache)
  return ok({ collections, parsedFiles, cachedFiles, componentTags: [...componentTags].sort() })
}
