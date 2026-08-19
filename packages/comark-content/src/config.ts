import { dirname } from 'node:path'

export interface StandardSchemaIssue {
  message: string
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
}

export interface StandardSchema {
  '~standard'?: {
    version: number
    vendor: string
    validate: (value: unknown) => unknown | Promise<unknown>
  }
}

export type GitRepository = string | {
  url: string
  branch?: string
  tag?: string
  auth?: { token: string }
}

export type CollectionSource = string | {
  include: string
  exclude?: string | string[]
  cwd?: string
  prefix?: string
  repository?: GitRepository
}

export interface CollectionDefinition<TSchema extends StandardSchema | undefined = StandardSchema | undefined> {
  type: 'page'
  source?: CollectionSource
  schema?: TSchema
  indexes?: Array<{ columns: string[] }>
  /** Set `false` to keep the collection out of the sitemap. */
  sitemap?: false
}

export interface ContentConfig<TCollections extends Record<string, CollectionDefinition> = Record<string, CollectionDefinition>> {
  collections: TCollections
}

/**
 * Reads the file extensions a glob names.
 * A glob with no extension returns an empty list.
 */
export function globExtensions(glob: string): string[] {
  const segment = glob.split('/').pop() ?? ''
  const braced = /\.\{([^}]*)\}$/.exec(segment)
  if (braced)
    return braced[1]!.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const dot = segment.lastIndexOf('.')
  return dot === -1 ? [] : [segment.slice(dot + 1).toLowerCase()]
}

export function defineCollection<const TSchema extends StandardSchema | undefined>(definition: CollectionDefinition<TSchema>): CollectionDefinition<TSchema> {
  if (definition.type !== 'page')
    throw new TypeError('Markdown page collections are the only supported collection type.')
  const source = typeof definition.source === 'string' ? definition.source : definition.source?.include
  const extensions = source ? globExtensions(source) : []
  if (extensions.length > 0 && !extensions.includes('md'))
    throw new TypeError('Markdown files are the only supported collection source.')
  return definition
}

export interface DeclaredCollections {
  configPath: string
  collections: Record<string, CollectionDefinition>
}

export interface MergedCollection {
  name: string
  rootDir: string
  configPath: string
  definition: CollectionDefinition
}

/**
 * Merges the collections of every content configuration file.
 * If two files define one name, this throws.
 */
export function mergeCollectionSources(declared: ReadonlyArray<DeclaredCollections>): MergedCollection[] {
  const merged = new Map<string, MergedCollection>()
  for (const file of declared) {
    const rootDir = dirname(file.configPath)
    for (const [name, definition] of Object.entries(file.collections)) {
      const existing = merged.get(name)
      if (existing)
        throw new TypeError(`${file.configPath}:1:1 Collection "${name}" is already defined in ${existing.configPath}. Rename one collection.`)
      merged.set(name, { name, rootDir, configPath: file.configPath, definition })
    }
  }
  return [...merged.values()]
}

export const defineContentConfig = <const TCollections extends Record<string, CollectionDefinition>>(config: ContentConfig<TCollections>) => config

export function assertSupportedOptions(options: Record<string, unknown>, source: string) {
  if (!('database' in options))
    return
  throw new TypeError(`${source}:1:1 Database adapters are outside the Markdown-only comark-content boundary.`)
}

export interface ContentDeploymentCache {
  preset: unknown
  moduleInstalled: boolean
  workersCache?: unknown
}

export function assertCloudflareCacheModule(integration: ContentDeploymentCache, source: string) {
  if (typeof integration.preset !== 'string' || !integration.preset.startsWith('cloudflare'))
    return
  if (!integration.moduleInstalled)
    throw new TypeError(`${source}:1:1 Cloudflare deployments require @harlan-zw/nuxt-cloudflare for Content caching.`)
  const cache = integration.workersCache
  if (!cache || typeof cache !== 'object' || !('enabled' in cache) || cache.enabled !== true)
    throw new TypeError(`${source}:1:1 Cloudflare deployments require Workers Caching from @harlan-zw/nuxt-cloudflare.`)
}
