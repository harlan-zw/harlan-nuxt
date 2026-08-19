import type { PageCollectionItemBase } from '../src/runtime/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryCollectionItemSurroundings, queryCollectionNavigation, queryCollectionSearchSections } from '../src/runtime/client'
import { createNavigation, createNavigationSource, createSearchSections, createSurroundings } from '../src/runtime/core/navigation'
import { createCacheableContentResponse, parseNavigationRequest, parseSearchRequest, parseSurroundingsRequest } from '../src/runtime/shared/protocol'

const body: PageCollectionItemBase['body'] = {
  frontmatter: {},
  meta: { toc: { links: [{ id: 'install', text: 'Install', depth: 2 }] } },
  toc: { links: [{ id: 'install', text: 'Install', depth: 2 }] },
  nodes: [
    ['h1', { id: 'guide' }, 'Guide'],
    ['p', {}, 'Opening text.'],
    ['h2', { id: 'install' }, 'Install'],
    ['p', {}, 'Run the command.'],
  ],
}

const pages: PageCollectionItemBase[] = [
  { id: 'pages/1.guide.md', path: '/guide', stem: '1.guide', extension: 'md', title: 'Guide', description: 'Start', body, _source: '/content/1.guide.md', new: true },
  { id: 'pages/guide/1.install.md', path: '/guide/install', stem: 'guide/1.install', extension: 'md', title: 'Install', description: '', body, _source: '/content/guide/1.install.md' },
  { id: 'pages/guide/2.hidden.md', path: '/guide/hidden', stem: 'guide/2.hidden', extension: 'md', title: 'Hidden', description: '', navigation: false, body, _source: '/content/guide/2.hidden.md' },
]

describe('derived collection data', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('creates nested navigation and carries requested fields', () => {
    expect(createNavigation(pages, ['new'])).toEqual([{
      title: 'Guide',
      path: '/guide',
      stem: '1.guide',
      page: true,
      new: true,
      children: [{ title: 'Install', path: '/guide/install', stem: 'guide/1.install', page: true, new: undefined }],
    }])
  })

  it('stores navigation metadata without page content', () => {
    const source = createNavigationSource(pages[0]!)

    expect(source).toEqual({
      path: '/guide',
      stem: '1.guide',
      title: 'Guide',
      description: 'Start',
      new: true,
    })
  })

  it('loads navigation through its cacheable GET boundary', async () => {
    const fetch = vi.fn().mockResolvedValue([])
    vi.stubGlobal('$fetch', fetch)

    await queryCollectionNavigation('pages', ['new'])

    expect(fetch).toHaveBeenCalledWith('/__comark_content/test-build/navigation/pages', {
      method: 'GET',
      query: { fields: 'new' },
    })
  })

  it('loads search sections through their cacheable GET boundary', async () => {
    const fetch = vi.fn().mockResolvedValue([])
    vi.stubGlobal('$fetch', fetch)

    await queryCollectionSearchSections('pages')

    expect(fetch).toHaveBeenCalledWith('/__comark_content/test-build/search/pages', {
      method: 'GET',
      query: {},
    })
  })

  it('loads surroundings through their cacheable GET boundary', async () => {
    const fetch = vi.fn().mockResolvedValue([null, null])
    vi.stubGlobal('$fetch', fetch)

    await queryCollectionItemSurroundings('pages', '/guide/install', { fields: ['title', 'description'] })

    expect(fetch).toHaveBeenCalledWith('/__comark_content/test-build/surroundings/pages', {
      method: 'GET',
      query: { path: '/guide/install', fields: 'title,description' },
    })
  })

  it('parses navigation route parameters once at the boundary', () => {
    expect(parseNavigationRequest('docsV4', 'new,deprecated,new')).toEqual({
      collection: 'docsV4',
      fields: ['new', 'deprecated'],
    })
  })

  it.each([
    ['../pages', undefined],
    ['pages', 'new,__proto__'],
    ['pages', ['new', 'deprecated']],
  ])('rejects unsafe navigation route parameters', (collection, fields) => {
    expect(() => parseNavigationRequest(collection, fields)).toThrow('<request>:1:1')
  })

  it('parses cacheable search and surroundings requests once at their boundaries', () => {
    expect(parseSearchRequest('docsV4')).toEqual({ collection: 'docsV4' })
    expect(parseSurroundingsRequest('docsV4', '/guide/install', 'title,description,title')).toEqual({
      collection: 'docsV4',
      path: '/guide/install',
      fields: ['title', 'description'],
    })
    expect(() => parseSearchRequest('../pages')).toThrow('<request>:1:1')
    expect(() => parseSurroundingsRequest('pages', 'guide', 'title')).toThrow('<request>:1:1')
    expect(() => parseSurroundingsRequest('pages', '/guide', '__proto__')).toThrow('<request>:1:1')
  })

  it('creates a content-addressed Cloudflare cache response with deterministic revalidation', () => {
    const value = [{ title: 'Guide', path: '/guide' }]
    const fresh = createCacheableContentResponse(value)
    const notModified = createCacheableContentResponse(value, `"other", ${fresh.headers.etag}`)

    expect(fresh).toEqual({
      _tag: 'Fresh',
      status: 200,
      body: value,
      headers: {
        'cache-control': 'public, max-age=31536000, immutable',
        'cloudflare-cdn-cache-control': 'public, max-age=31536000, immutable',
        'etag': fresh.headers.etag,
      },
    })
    expect(createCacheableContentResponse([{ title: 'Changed', path: '/guide' }]).headers.etag).not.toBe(fresh.headers.etag)
    expect(notModified).toEqual({
      _tag: 'NotModified',
      status: 304,
      body: null,
      headers: fresh.headers,
    })
    expect(createCacheableContentResponse(value, fresh.headers.etag, { _tag: 'NoStore' })).toEqual({
      _tag: 'Fresh',
      status: 200,
      body: value,
      headers: {
        'cache-control': 'no-store',
        'cloudflare-cdn-cache-control': 'no-store',
      },
    })
  })

  it('creates folder nodes when no index page exists', () => {
    const folderPages = pages.slice(1, 2).map(page => ({
      ...page,
      path: '/docs/guides/install',
      stem: 'docs/1.guides/1.install',
    }))

    expect(createNavigation(folderPages)).toEqual([{
      title: 'Docs',
      path: '/docs',
      stem: 'docs',
      page: false,
      children: [{
        title: 'Guides',
        path: '/docs/guides',
        stem: 'docs/1.guides',
        page: false,
        children: [{
          title: 'Install',
          path: '/docs/guides/install',
          stem: 'docs/1.guides/1.install',
          page: true,
        }],
      }],
    }])
  })

  it('returns previous and next items in stem order', () => {
    expect(createSurroundings(pages, '/guide/install', ['title', 'description'])).toEqual([
      { title: 'Guide', description: 'Start', path: '/guide' },
      null,
    ])
  })

  it('splits searchable text by headings', () => {
    expect(createSearchSections(pages.slice(0, 1))).toEqual([
      { id: '/guide#guide', title: 'Guide', titles: [], content: 'Opening text.', level: 1 },
      { id: '/guide#install', title: 'Install', titles: ['Guide'], content: 'Run the command.', level: 2 },
    ])
  })

  it('keeps searchable text before the first heading', () => {
    const [page] = pages
    if (!page)
      throw new Error('Missing page fixture.')
    const sections = createSearchSections([{
      ...page,
      body: { ...page.body, nodes: [['p', {}, 'Preface.'], ...page.body.nodes] },
    }])

    expect(sections[0]?.content).toBe('Preface. Opening text.')
  })
})
