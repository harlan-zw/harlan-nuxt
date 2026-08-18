import type { MarkdownDocument } from 'comark'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineCollection } from '../src/config'
import { createContentParser, ingestCollections } from '../src/core/ingest'
import { writeFixture } from './fixtures'

const temporaryRoots: string[] = []

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'comark-content-ingest-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('markdown ingestion', () => {
  it('highlights fenced code when requested', async () => {
    const parse = await createContentParser({ highlight: true })
    const document = await parse('```ts{1} [app.ts]\nconst ready = true\n```')
    const pre = document.nodes[0]

    expect(pre).toMatchObject([
      'pre',
      {
        class: expect.stringContaining('rangi shiki shj-lang-ts'),
        filename: 'app.ts',
        highlights: [1],
      },
      ['code', { class: 'language-ts' }, [
        'span',
        { class: 'line highlight' },
        ['span', {
          class: expect.stringContaining('shj-kwd'),
          style: expect.stringMatching(/^--shiki-light:.+;--shiki-default:.+;color:.+;--shiki-dark:.+$/),
        }, 'const'],
        expect.any(String),
        expect.any(Array),
        expect.any(String),
        expect.any(Array),
      ]],
    ])
  })

  it('uses readable Rangi themes by default', async () => {
    const parse = await createContentParser({ highlight: true })
    const document = await parse('```ts\nconst ready = true\n```')

    expect(document.nodes[0]).toMatchObject([
      'pre',
      expect.any(Object),
      ['code', expect.any(Object), ['span', expect.any(Object), ['span', { style: '--shiki-light:#cf222e;--shiki-default:#cf222e;color:#cf222e;--shiki-dark:#ff7b72' }, 'const'], expect.any(String), expect.any(Array), expect.any(String), expect.any(Array)]],
    ])
  })

  it('uses an AA contrast light comment color', async () => {
    const parse = await createContentParser({ highlight: true })
    const document = await parse('```ts\n// note\n```')

    expect(document.nodes[0]).toMatchObject([
      'pre',
      expect.any(Object),
      ['code', expect.any(Object), ['span', expect.any(Object), [
        'span',
        { class: expect.stringContaining('shj-cmnt'), style: expect.stringContaining('--shiki-light:#57606a') },
        '// note',
      ]]],
    ])
  })

  it('highlights bundled dotenv and robots.txt fences', async () => {
    const parse = await createContentParser({ highlight: true })
    const document = await parse([
      '```dotenv',
      '# Keep escaped newlines',
      'GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIEvQ...\\n-----END PRIVATE KEY-----\\n"',
      '```',
      '',
      '```robots.txt',
      'User-agent: *',
      'Disallow: /private/',
      '```',
    ].join('\n'))

    expect(document.nodes[0]).toMatchObject([
      'pre',
      { class: expect.stringContaining('shj-lang-dotenv') },
      ['code', expect.any(Object), [
        'span',
        expect.any(Object),
        ['span', { class: expect.stringContaining('shj-cmnt') }, '# Keep escaped newlines'],
      ], expect.any(String), [
        'span',
        expect.any(Object),
        ['span', { class: expect.stringContaining('shj-var') }, 'GOOGLE_PRIVATE_KEY'],
        ['span', { class: expect.stringContaining('shj-oper') }, '='],
        ['span', { class: expect.stringContaining('shj-str') }, '"-----BEGIN PRIVATE KEY-----\\nMIIEvQ...\\n-----END PRIVATE KEY-----\\n"'],
      ]],
    ])
    expect(document.nodes[1]).toMatchObject([
      'pre',
      { class: expect.stringContaining('shj-lang-robots.txt') },
      ['code', expect.any(Object), [
        'span',
        expect.any(Object),
        ['span', { class: expect.stringContaining('shj-kwd') }, 'User-agent'],
        ['span', { class: expect.stringContaining('shj-oper') }, ':'],
        ['span', { class: expect.stringContaining('shj-str') }, ' '],
        ['span', { class: expect.stringContaining('shj-oper') }, '*'],
      ], expect.any(String), [
        'span',
        expect.any(Object),
        ['span', { class: expect.stringContaining('shj-kwd') }, 'Disallow'],
        ['span', { class: expect.stringContaining('shj-oper') }, ':'],
        ['span', { class: expect.stringContaining('shj-str') }, ' /private/'],
      ]],
    ])
  })

  it('highlights a bundled fenced code language', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/example.md', '```csharp\nvar ready = true;\n```')

    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ], { cacheFile: join(root, 'cache.json'), highlight: true })

    expect(result._tag).toBe('Ok')
    if (result._tag === 'Err')
      return
    expect(result.value.collections.pages?.[0]?.body.nodes[0]).toMatchObject([
      'pre',
      { class: expect.stringContaining('rangi') },
      ['code', { class: 'language-csharp' }, ['span', expect.any(Object), ['span', { class: expect.stringContaining('shj-kwd') }, 'var'], expect.any(String), expect.any(Array), expect.any(String), expect.any(Array), expect.any(String)]],
    ])
  })

  it('uses site-defined Rangi languages and themes', async () => {
    const parse = await createContentParser({
      highlight: {
        languages: { fixture: [[/ready/g, 'kwd']] },
        theme: { name: 'fixture', bg: '#fff', fg: '#000', tokens: { kwd: '#123456' } },
      },
    })
    const document = await parse('```fixture\nready\n```')

    expect(document.nodes[0]).toMatchObject([
      'pre',
      expect.any(Object),
      ['code', {}, ['span', expect.any(Object), ['span', { style: '--shiki-light:#123456;--shiki-default:#123456;color:#123456' }, 'ready']]],
    ])
  })

  it('invalidates cached documents when a custom Rangi grammar changes', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/example.md', '```fixture\nready waiting\n```')
    const collection = {
      name: 'pages',
      rootDir: root,
      definition: defineCollection({ type: 'page', source: '**/*.md' }),
    }
    const cacheFile = join(root, 'cache.json')

    await ingestCollections([collection], {
      cacheFile,
      highlight: { languages: { fixture: [[/ready/g, 'kwd']] } },
    })
    const changed = await ingestCollections([collection], {
      cacheFile,
      highlight: { languages: { fixture: [[/waiting/g, 'kwd']] } },
    })

    expect(changed).toMatchObject({ _tag: 'Ok', value: { parsedFiles: 1, cachedFiles: 0 } })
  })

  it('returns an empty collection when no Markdown matches', async () => {
    const root = await temporaryRoot()
    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result).toEqual({ _tag: 'Ok', value: { collections: { pages: [] }, sitemapCollections: ['pages'], parsedFiles: 0, cachedFiles: 0, componentTags: [] } })
  })

  it('reports the collections that opted out of the sitemap', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/page.md', '# Page')

    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
      { name: 'snippets', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md', sitemap: false }) },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result).toMatchObject({ _tag: 'Ok', value: { sitemapCollections: ['pages'] } })
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
      body: {
        frontmatter: { title: 'Guide' },
        meta: { title: 'Guide', description: 'Start here.' },
      },
    }])
    expect(result.value.collections.pages?.[0]).not.toHaveProperty('rawbody')
    expect(result.value.collections.pages?.[0]?.body.nodes[0]).toEqual(['h1', { id: 'guide' }, 'Guide'])
    expect(result.value.collections.pages?.[0]?.body.meta.toc.links).toEqual([{ id: 'next', depth: 2, text: 'Next' }])
    expect(result.value.collections.pages?.[0]?.body.toc.links).toEqual([{ id: 'next', depth: 2, text: 'Next' }])
  })

  it('runs Nuxt Content parse hooks around each Markdown document', async () => {
    const root = await temporaryRoot()
    const path = await writeFixture(root, 'content/guide.md', '# Original')
    const calls: string[] = []

    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ], {
      cacheFile: join(root, 'cache.json'),
      beforeParse: async (context) => {
        calls.push(`before:${context.file.id}`)
        expect(context.file.path).toBe(path)
        expect(context.collection).toMatchObject({ name: 'pages', type: 'page' })
        context.file.body = '# Changed by hook'
      },
      afterParse: async (context) => {
        calls.push(`after:${context.content.path}`)
        expect(context.content.rawbody).toBe('# Changed by hook')
        context.content = { ...context.content, seo: { robots: 'noindex' } }
      },
    })

    expect(calls).toEqual(['before:pages/guide.md', 'after:/guide'])
    expect(result).toMatchObject({
      _tag: 'Ok',
      value: { collections: { pages: [{ title: 'Changed by hook', seo: { robots: 'noindex' } }] } },
    })
  })

  it('runs file hooks in source order', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/a.md', '# A')
    await writeFixture(root, 'content/b.md', '# B')
    const calls: string[] = []

    await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ], {
      cacheFile: join(root, 'cache.json'),
      beforeParse: async ({ file }) => {
        if (file.id.endsWith('/a.md'))
          await new Promise(resolve => setTimeout(resolve, 10))
        calls.push(`before:${file.id}`)
      },
      afterParse: async ({ file }) => {
        calls.push(`after:${file.id}`)
      },
    })

    expect(calls).toEqual([
      'before:pages/a.md',
      'before:pages/b.md',
      'after:pages/a.md',
      'after:pages/b.md',
    ])
  })

  it('builds paths relative to the static source directory', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/docs/guide.md', '# Guide')

    const result = await ingestCollections([
      {
        name: 'pages',
        rootDir: root,
        definition: defineCollection({
          type: 'page',
          source: { include: 'docs/**/*.md', prefix: '/reference' },
        }),
      },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result).toMatchObject({
      _tag: 'Ok',
      value: { collections: { pages: [{ path: '/reference/guide', stem: 'guide' }] } },
    })
  })

  it('preserves built-in frontmatter omitted by a stripping schema', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/page.md', '---\ntitle: Kept title\nnavigation:\n  title: Kept navigation\ncustom: value\n---\n# Page')
    const schema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: { custom: 'transformed' } }),
      },
    }

    const result = await ingestCollections([
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md', schema }) },
    ], { cacheFile: join(root, 'cache.json') })

    expect(result).toMatchObject({
      _tag: 'Ok',
      value: {
        collections: {
          pages: [{ title: 'Kept title', navigation: { title: 'Kept navigation' }, custom: 'transformed' }],
        },
      },
    })
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

  it('rejects the previous Rangi cache version', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'content/page.md', '# Page')
    const cacheFile = join(root, 'cache.json')
    const parse = vi.fn(async (): Promise<MarkdownDocument> => ({ nodes: [], frontmatter: {}, meta: {} }))
    const collections = [
      { name: 'pages', rootDir: root, definition: defineCollection({ type: 'page', source: '**/*.md' }) },
    ]
    await ingestCollections(collections, { cacheFile, parse })
    const cache = JSON.parse(await readFile(cacheFile, 'utf8'))
    await writeFile(cacheFile, JSON.stringify({ ...cache, version: 'comark-content:2:comark-0.6.2:rangi-2.2.0' }))

    const result = await ingestCollections(collections, { cacheFile, parse })

    expect(parse).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ _tag: 'Ok', value: { parsedFiles: 1, cachedFiles: 0 } })
  })
})
