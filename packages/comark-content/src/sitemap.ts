interface SitemapOptions {
  excludeAppSources?: true | string[]
  [key: string]: unknown
}

const NUXT_CONTENT_SOURCE = '@nuxt/content@v3:urls'

/**
 * The route @nuxt/content's sitemap integration serves.
 *
 * @nuxtjs/sitemap registers this source against its own resolved config during its
 * setup. A module that runs later, as this one does whenever @nuxtjs/sitemap is
 * listed first, cannot exclude it any more, and the source outlives @nuxt/content
 * in a restored build cache either way. Comark answers the route instead.
 */
export const NUXT_CONTENT_SITEMAP_ROUTE = '/__sitemap__/nuxt-content-urls.json'

export function excludeNuxtContentSitemapSource(options: SitemapOptions | undefined): SitemapOptions {
  if (options?.excludeAppSources === true)
    return options
  const excluded = options?.excludeAppSources ?? []
  if (excluded.includes(NUXT_CONTENT_SOURCE))
    return options ?? { excludeAppSources: excluded }
  return {
    ...options,
    excludeAppSources: [...excluded, NUXT_CONTENT_SOURCE],
  }
}
