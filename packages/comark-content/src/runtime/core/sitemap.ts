import type { ContentDocumentMetadata } from '../types'

export interface ContentSitemapEntry {
  loc: string
  lastmod?: string
  [key: string]: unknown
}

export function createSitemapEntries(pages: ContentDocumentMetadata[]): ContentSitemapEntry[] {
  return pages.flatMap((page) => {
    if (page.sitemap === false || page.robots === false)
      return []
    const metadata = typeof page.sitemap === 'object' && page.sitemap ? page.sitemap : {}
    const lastmod = page.updatedAt ?? page.publishedAt
    return [{
      loc: page.path,
      ...(lastmod ? { lastmod: String(lastmod) } : {}),
      ...metadata,
    }]
  })
}
