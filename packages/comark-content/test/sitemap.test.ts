import { describe, expect, it } from 'vitest'
import { excludeNuxtContentSitemapSource, NUXT_CONTENT_SITEMAP_ROUTE } from '../src/sitemap'

describe('sitemap source exclusion', () => {
  it('adds the nuxt content source to an empty exclude list', () => {
    expect(excludeNuxtContentSitemapSource(undefined)).toEqual({ excludeAppSources: ['@nuxt/content@v3:urls'] })
  })

  it('keeps a blanket exclusion untouched', () => {
    expect(excludeNuxtContentSitemapSource({ excludeAppSources: true })).toEqual({ excludeAppSources: true })
  })

  it('preserves existing exclusions and other options', () => {
    expect(excludeNuxtContentSitemapSource({ excludeAppSources: ['nuxt:pages'], zeroRuntime: true })).toEqual({
      excludeAppSources: ['nuxt:pages', '@nuxt/content@v3:urls'],
      zeroRuntime: true,
    })
  })

  it('does not add the source twice', () => {
    expect(excludeNuxtContentSitemapSource({ excludeAppSources: ['@nuxt/content@v3:urls'] })).toEqual({
      excludeAppSources: ['@nuxt/content@v3:urls'],
    })
  })

  // The exclusion above is lost whenever @nuxtjs/sitemap resolves its options first,
  // so the source has to stay answerable rather than 404 the sitemap route.
  it('names the route the surviving source fetches', () => {
    expect(NUXT_CONTENT_SITEMAP_ROUTE).toBe('/__sitemap__/nuxt-content-urls.json')
  })
})
