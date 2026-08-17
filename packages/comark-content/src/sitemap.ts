interface SitemapOptions {
  excludeAppSources?: true | string[]
  [key: string]: unknown
}

const NUXT_CONTENT_SOURCE = '@nuxt/content@v3:urls'

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
