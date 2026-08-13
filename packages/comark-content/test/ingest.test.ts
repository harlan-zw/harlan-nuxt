import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from 'comark'
import { defineCollection } from '../src/config'
import { ingestCollections } from '../src/core/ingest'
import { writeFixture } from './fixtures'

const temporaryRoots: string[] = []

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'comark-content-ingest-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Markdown ingestion', () => {
  it('returns an empty collection when no Markdown matches', async () => {
    const root = await temporaryRoot()
    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result).toEqual({ _tag: 'Ok', value: { collections: { pages: [] }, parsedFiles: 0, cachedFiles: 0, componentTags: [] } })
  })

  it('parses frontmatter and exposes the direct Comark document', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/1.guide/0.index.md', '---\ntitle: Guide\n---\n# Guide\n\nStart here.\n\n## Next')

    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result._tag).toBe('Ok')
    if (result._tag === 'Err')
      return
    expect(result.value.collections.pages).toMatchObject([{
      id: 'pages/1.guide/0.index.md',
      path: '/guide',
      stem: '1.guide/0.index',
      title: 'Guide',
      description: 'Start here.',
      rawbody: '---\ntitle: Guide\n---\n# Guide\n\nStart here.\n\n## Next',
      body: {
        frontmatter: { title: 'Guide' },
        meta: { title: 'Guide', description: 'Start here.' },
      },
    }])
    expect(result.value.collections.pages?.[0]?.body.nodes[0]).toEqual(['h1', { id: 'guide' }, 'Guide'])
    expect(result.value.collections.pages?.[0]?.body.meta.toc.links).toEqual([{ id: 'next', depth: 2, text: 'Next' }])
    expect(result.value.collections.pages?.[0]?.body.toc.links).toEqual([{ id: 'next', depth: 2, text: 'Next' }])
  })

  it('reports malformed frontmatter with its file and location', async () => {
    const root = await temporaryRoot()
    const path = await writeFixture(root, 'content/broken.md', '---\ntitle: [broken\n---\n# Broken')

    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result).toMatchObject({
      _tag: 'Err',
      error: { _tag: 'ParseError', source: path, line: 2 },
    })
    if (result._tag === 'Err')
      expect(result.error.message).toContain(`${path}:2:`)
  })

  it('reports schema failures at the frontmatter field', async () => {
    const root = await temporaryRoot()
    const path = await writeFixture(root, 'content/page.md', '---\ntitle: 42\n---\n# Page')
    const schema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'Expected a string', path: ['title'] }] }),
      },
    }

    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md', schema }) },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result).toMatchObject({
      _tag: 'Err',
      error: { _tag: 'SchemaError', source: path, line: 2, column: 1 },
    })
  })

  it('parses only a changed file when the cache is current', async () => {
    const root = await temporaryRoot()
    const sourcePath = await writeFixture(root, 'content/page.md', '# Page')
    const parse = vi.fn(async (): Promise<MarkdownDocument> => ({ nodes: [['h1', { id: 'page' }, 'Page']], frontmatter: {}, meta: {} }))
    const collections = [
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ]
    const options = { cacheFile: join(root, 'cache.json'), parse }

    await ingestCollections(collections, options)
    const cached = await ingestCollections(collections, options)
    await writeFile(sourcePath, '# Changed')
    const changed = await ingestCollections(collections, options)

    expect(parse).toHaveBeenCalledTimes(2)
    expect(cached).toMatchObject({ _tag: 'Ok', value: { parsedFiles: 0, cachedFiles: 1 } })
    expect(changed).toMatchObject({ _tag: 'Ok', value: { parsedFiles: 1, cachedFiles: 0 } })
  })

  it('rejects a stale cache version', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/page.md', '# Page')
    const cacheFile = join(root, 'cache.json')
    const parse = vi.fn(async (): Promise<MarkdownDocument> => ({ nodes: [], frontmatter: {}, meta: {} }))
    const collections = [
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ]
    await ingestCollections(collections, { cacheFile, parse })
    const cache = JSON.parse(await readFile(cacheFile, 'utf8'))
    await writeFile(cacheFile, JSON.stringify({ ...cache, version: 'stale' }))

    const result = await ingestCollections(collections, { cacheFile, parse })

    expect(parse).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ _tag: 'Ok', value: { parsedFiles: 1, cachedFiles: 0 } })
  })
})
