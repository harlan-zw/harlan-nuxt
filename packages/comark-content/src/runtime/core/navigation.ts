import type { Node } from 'comark'
import type { ContentNavigationItem, ContentSearchSection, NavigationCollectionItem, PageCollectionItemBase } from '../types'
import { generatedTitle } from './path'

function text(node: Node): string {
  return typeof node === 'string'
    ? node
    : node.slice(2).map(child => text(child as Node)).join('')
}

function navigationItem(page: NavigationCollectionItem, fields: string[]): ContentNavigationItem {
  const navigation = page.navigation
  const metadata = typeof navigation === 'object' && navigation ? navigation : {}
  return {
    title: typeof navigation === 'string' ? navigation : String(metadata.title ?? page.title),
    path: page.path,
    ...Object.fromEntries(fields.map(field => [field, page[field]])),
    ...metadata,
  }
}

export function createNavigationSource(page: PageCollectionItemBase): NavigationCollectionItem {
  return Object.fromEntries(
    Object.entries(page).filter(([key]) => !['body', 'id', 'extension', '_source', 'seo', 'sitemap', 'robots'].includes(key)),
  ) as NavigationCollectionItem
}

export function createNavigation(pages: NavigationCollectionItem[], fields: string[] = []): ContentNavigationItem[] {
  const included = pages.filter(page => page.navigation !== false).sort((left, right) => left.stem.localeCompare(right.stem))
  type TreeItem = ContentNavigationItem & { _sort: string, children?: TreeItem[] }
  const byPath = new Map<string, TreeItem>()
  for (const page of included) {
    const { children: _children, ...item } = navigationItem(page, fields)
    byPath.set(page.path, {
      ...item,
      stem: page.stem,
      page: true,
      _sort: page.stem,
    })
  }
  for (const page of included) {
    const pathParts = page.path.split('/').filter(Boolean)
    const stemParts = page.stem.split('/')
    const stemOffset = pathParts.length - stemParts.length
    for (let index = 0; index < pathParts.length - 1; index++) {
      const path = `/${pathParts.slice(0, index + 1).join('/')}`
      const rawParts = pathParts.slice(0, index + 1).map((part, partIndex) => stemParts[partIndex - stemOffset] ?? part)
      const stem = rawParts.join('/')
      if (!byPath.has(path)) {
        byPath.set(path, {
          title: generatedTitle(path),
          path,
          stem,
          page: false,
          _sort: stem,
        })
      }
    }
  }
  const roots: TreeItem[] = []
  for (const item of byPath.values()) {
    const parentPath = item.path.split('/').slice(0, -1).join('/') || '/'
    const parent = byPath.get(parentPath)
    if (!parent) {
      roots.push(item)
      continue
    }
    parent.children ||= []
    parent.children.push(item)
  }
  const project = (items: TreeItem[]): ContentNavigationItem[] => items
    .toSorted((left, right) => left._sort.localeCompare(right._sort))
    .map(({ _sort, children, ...item }) => ({
      ...item,
      ...(children?.length ? { children: project(children) } : {}),
    }))
  return project(roots)
}

export function createSurroundings(pages: NavigationCollectionItem[], path: string, fields: string[] = []): [ContentNavigationItem | null, ContentNavigationItem | null] {
  const ordered = pages.filter(page => page.navigation !== false).sort((left, right) => left.stem.localeCompare(right.stem))
  const index = ordered.findIndex(page => page.path === path)
  const project = (page?: NavigationCollectionItem) => page
    ? navigationItem(page, fields)
    : null
  return index === -1 ? [null, null] : [project(ordered[index - 1]), project(ordered[index + 1])]
}

function appendText(section: ContentSearchSection, value: string) {
  const next = value.trim()
  if (next)
    section.content = `${section.content} ${next}`.trim()
}

export function createSearchSections(pages: PageCollectionItemBase[]): ContentSearchSection[] {
  return pages.flatMap((page) => {
    const sections: ContentSearchSection[] = []
    const titles: string[] = []
    let current: ContentSearchSection | undefined
    let preface = ''
    for (const node of page.body.nodes) {
      if (typeof node !== 'string' && typeof node[0] === 'string' && /^h[1-6]$/.test(node[0])) {
        const level = Number(node[0].slice(1))
        const title = text(node)
        titles.splice(level - 1)
        current = {
          id: `${page.path}#${String(node[1].id ?? '')}`,
          title,
          titles: [...titles],
          content: '',
          level,
        }
        sections.push(current)
        if (sections.length === 1)
          appendText(current, preface)
        titles[level - 1] = title
        continue
      }
      if (current)
        appendText(current, text(node))
      else
        preface = `${preface} ${text(node)}`.trim()
    }
    return sections
  })
}
