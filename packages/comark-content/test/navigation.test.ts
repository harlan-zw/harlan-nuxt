import { describe, expect, it } from 'vitest'
import type { PageCollectionItemBase } from '../src/runtime/types'
import { createNavigation, createSearchSections, createSurroundings } from '../src/runtime/core/navigation'
import { createSitemapEntries } from '../src/runtime/core/sitemap'

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
  { id: 'pages/1.guide.md', path: '/guide', stem: '1.guide', extension: 'md', title: 'Guide', description: 'Start', rawbody: '# Guide', body, _source: '/content/1.guide.md', new: true },
  { id: 'pages/guide/1.install.md', path: '/guide/install', stem: 'guide/1.install', extension: 'md', title: 'Install', description: '', rawbody: '# Install', body, _source: '/content/guide/1.install.md' },
  { id: 'pages/guide/2.hidden.md', path: '/guide/hidden', stem: 'guide/2.hidden', extension: 'md', title: 'Hidden', description: '', rawbody: '# Hidden', navigation: false, body, _source: '/content/guide/2.hidden.md' },
]

describe('derived collection data', () => {
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

  it('projects collection pages into sitemap entries', () => {
    expect(createSitemapEntries([
      { ...pages[0]!, updatedAt: '2026-08-14', sitemap: { changefreq: 'weekly' } },
      { ...pages[1]!, robots: false },
      { ...pages[2]!, navigation: true, sitemap: false },
    ])).toEqual([{ loc: '/guide', lastmod: '2026-08-14', changefreq: 'weekly' }])
  })
})
