export interface ContentHighlightOptions {
  langs?: Array<string | object>
  theme?: {
    default?: string
    light?: string
    dark?: string
  }
  transformers?: object[]
}

export type ContentHighlight = boolean | ContentHighlightOptions

type BundledLoader = () => Promise<{ default: unknown }>
type ResolvedShikiOptions = {
  languages?: unknown[]
  themes?: { light?: unknown, dark?: unknown }
  transformers?: object[]
}

const plainLanguages = new Set(['text', 'txt', 'plaintext'])

const loadRegistration = async (name: string, loaders: Record<string, BundledLoader>, kind: 'language' | 'theme') => {
  const loader = loaders[name]
  if (!loader)
    throw new TypeError(`Unknown Shiki ${kind} "${name}".`)
  return (await loader()).default
}

export const resolveShikiOptions = async (highlight: Exclude<ContentHighlight, false>): Promise<ResolvedShikiOptions> => {
  if (highlight === true)
    return {}

  const options: ResolvedShikiOptions = {}
  if (highlight.langs) {
    const { bundledLanguages, bundledLanguagesAlias } = await import('shiki/langs')
    const loaders = { ...bundledLanguages, ...bundledLanguagesAlias } as Record<string, BundledLoader>
    options.languages = await Promise.all(highlight.langs
      .filter(language => typeof language !== 'string' || !plainLanguages.has(language))
      .map(language => typeof language === 'string' ? loadRegistration(language, loaders, 'language') : language))
  }

  if (highlight.theme) {
    const { bundledThemes } = await import('shiki/themes')
    const loaders = bundledThemes as Record<string, BundledLoader>
    const light = highlight.theme.light ?? highlight.theme.default
    const dark = highlight.theme.dark ?? light
    options.themes = {
      ...(light ? { light: await loadRegistration(light, loaders, 'theme') } : {}),
      ...(dark ? { dark: await loadRegistration(dark, loaders, 'theme') } : {}),
    }
  }

  options.transformers = highlight.transformers

  return options
}

export const highlightCacheKey = (highlight: ContentHighlight | undefined) => highlight ? JSON.stringify(highlight) : 'plain'
