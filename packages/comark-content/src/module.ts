import type { NitroConfig } from 'nitropack/types'
import type { ContentConfig } from './config'
import type { LoadedCollection } from './core/ingest'
import type { ContentHighlight } from './highlight'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import {
  addComponent,
  addImports,
  addServerHandler,
  addServerPlugin,
  addTemplate,
  createResolver,
  defineNuxtModule,
  hasNuxtModule,
  importModule,
  updateTemplates,
  useLogger,
} from '@nuxt/kit'
import { addUnprefixedContentAliases, contentComponentDirectories, localizeNuxtUiProseComponents, renderComponentManifest } from './components'
import { assertCloudflareCacheModule, assertSupportedOptions } from './config'
import { createContentAssetPlan, createContentRevision } from './core/asset'
import { ingestCollections } from './core/ingest'
import { excludeNuxtContentSitemapSource } from './sitemap'

export * from './config'
export type * from './highlight'
export type * from './hooks'
export type * from './runtime/types'

export interface ModuleOptions {
  database?: never
  highlight?: ContentHighlight
}

declare module '@nuxt/schema' {
  interface NuxtConfig {
    content?: ModuleOptions
  }

  interface NuxtOptions {
    content: ModuleOptions
  }
}

const contentConfigNames = ['content.config.ts', 'content.config.mts', 'content.config.js', 'content.config.mjs']

function layerRoot(layer: Record<string, unknown>) {
  const config = layer.config as Record<string, unknown> | undefined
  return String(config?.rootDir ?? layer.cwd ?? '')
}

async function loadCollections(layers: ReadonlyArray<Record<string, unknown>>): Promise<LoadedCollection[]> {
  const collections = new Map<string, LoadedCollection>()
  for (const layer of [...layers].reverse()) {
    const rootDir = layerRoot(layer)
    if (!rootDir)
      continue
    const configPath = contentConfigNames.map(name => join(rootDir, name)).find(existsSync)
    if (!configPath)
      continue
    const config = await importModule<ContentConfig>(configPath, { interopDefault: true })
    for (const [name, definition] of Object.entries(config.collections)) {
      collections.set(name, { name, definition, rootDir: dirname(configPath) })
    }
  }
  return [...collections.values()]
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/comark-content',
    configKey: 'content',
    compatibility: { nuxt: '>=4.5.0 <5.0.0' },
  },
  moduleDependencies: {
    '@nuxt/ui': {
      version: '>=4.0.0',
      optional: true,
      defaults: { content: true, prose: true },
    },
    '@nuxtjs/sitemap': {
      version: '>=8.0.0',
      optional: true,
      defaults: { excludeAppSources: ['@nuxt/content@v3:urls'] },
    },
    '@harlan-zw/nuxt-cloudflare': {
      version: '>=0.0.14',
      optional: true,
    },
  },
  defaults: {},
  async setup(options, nuxt) {
    assertSupportedOptions(options as Record<string, unknown>, join(nuxt.options.rootDir, 'nuxt.config.ts'))
    const nuxtOptions = nuxt.options as typeof nuxt.options & { sitemap?: Parameters<typeof excludeNuxtContentSitemapSource>[0] }
    nuxtOptions.sitemap = excludeNuxtContentSitemapSource(nuxtOptions.sitemap)
    const resolver = createResolver(import.meta.url)
    nuxt.options.css.push(resolver.resolve('./runtime/rangi.css'))
    const outputDir = join(nuxt.options.rootDir, 'node_modules/.cache/comark-content/generated')
    const cacheFile = join(nuxt.options.rootDir, '.data/comark-content/cache.json')
    const remoteCacheDir = join(nuxt.options.rootDir, 'node_modules/.cache/comark-content/git')
    const logger = useLogger('comark-content')
    const componentTags = new Set<string>()
    let scannedComponents: Parameters<typeof renderComponentManifest>[1] = []
    let initializedCollections = false

    const contentComponents: string[] = []
    for (const path of contentComponentDirectories(nuxt.options._layers)) {
      if ((await stat(path).catch(() => undefined))?.isDirectory())
        contentComponents.push(path)
    }
    const componentsFilename = 'comark-content/components.mjs'
    const componentsTemplatePath = join(nuxt.options.buildDir, componentsFilename)
    const componentsTemplate = addTemplate({
      filename: componentsFilename,
      write: true,
      getContents: () => renderComponentManifest(componentTags, scannedComponents, dirname(componentsTemplatePath)),
    })
    nuxt.options.alias['#comark-content/components'] = componentsTemplate.dst

    nuxt.hook('components:extend', (components) => {
      const aliases = addUnprefixedContentAliases(components, contentComponents)
      const localized = localizeNuxtUiProseComponents(aliases)
      components.splice(0, components.length, ...localized)
      scannedComponents = localized
    })

    addComponent({ name: 'ContentRenderer', filePath: resolver.resolve('./runtime/components/ContentRenderer') })
    addImports([
      { name: 'queryCollection', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionNavigation', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionItemSurroundings', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionSearchSections', from: resolver.resolve('./runtime/client') },
    ])
    addServerHandler({ route: '/__comark_content/query', method: 'post', handler: resolver.resolve('./runtime/server/api/query.post') })
    addServerPlugin(resolver.resolve('./runtime/server/plugins/sitemap'))

    nuxt.hook('nitro:config', (config: NitroConfig) => {
      config.serverAssets ||= []
      config.serverAssets.push({ baseName: 'comark-content', dir: outputDir })
      const cloudflare = (config as NitroConfig & { cloudflare?: { wrangler?: { cache?: unknown } } }).cloudflare
      assertCloudflareCacheModule({
        preset: config.preset ?? process.env.NITRO_PRESET ?? nuxt.options.nitro.preset,
        moduleInstalled: hasNuxtModule('@harlan-zw/nuxt-cloudflare', nuxt),
        workersCache: cloudflare?.wrangler?.cache,
      }, join(nuxt.options.rootDir, 'nuxt.config.ts'))
    })

    if (nuxt.options._prepare)
      return

    const buildCollections = async () => {
      const loaded = await loadCollections(nuxt.options._layers as unknown as ReadonlyArray<Record<string, unknown>>)
      const startedAt = performance.now()
      const result = await ingestCollections(loaded, {
        cacheFile,
        remoteCacheDir,
        highlight: options.highlight,
        beforeParse: context => nuxt.callHook('content:file:beforeParse', context),
        afterParse: context => nuxt.callHook('content:file:afterParse', context),
      })
      if (result._tag === 'Err')
        throw new Error(result.error.message, { cause: result.error.cause })
      componentTags.clear()
      for (const tag of result.value.componentTags)
        componentTags.add(tag)
      if (initializedCollections)
        await updateTemplates({ filter: template => template.dst === componentsTemplate.dst })
      initializedCollections = true
      await rm(outputDir, { recursive: true, force: true })
      await mkdir(outputDir, { recursive: true })
      const assetPlan = createContentAssetPlan(result.value.collections)
      await Promise.all(assetPlan.assets.map(async (asset) => {
        const path = join(outputDir, asset.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, asset.data)
      }))
      const files = Object.values(result.value.collections).reduce((sum, items) => sum + items.length, 0)
      logger.success(`Processed ${loaded.length} collections and ${files} files in ${(performance.now() - startedAt).toFixed(2)}ms (${result.value.cachedFiles} cached, ${result.value.parsedFiles} parsed)`)
      return nuxt.options.dev ? 'dev' : createContentRevision(nuxt.options.buildId, result.value.collections)
    }

    nuxt.hook('modules:done', async () => {
      const contentRevision = await buildCollections()
      nuxt.options.runtimeConfig.public.comarkContentRevision = contentRevision
      const contentRouteBase = `/__comark_content/${encodeURIComponent(contentRevision)}`
      addServerHandler({ route: `${contentRouteBase}/navigation/:collection`, method: 'get', handler: resolver.resolve('./runtime/server/api/navigation.get') })
      addServerHandler({ route: `${contentRouteBase}/search/:collection`, method: 'get', handler: resolver.resolve('./runtime/server/api/search.get') })
      addServerHandler({ route: `${contentRouteBase}/surroundings/:collection`, method: 'get', handler: resolver.resolve('./runtime/server/api/surroundings.get') })
    })
    let rebuild = Promise.resolve()
    nuxt.hook('builder:watch', (event, path) => {
      if (event !== 'change' || !path.endsWith('.md'))
        return
      rebuild = rebuild.then(async () => {
        await buildCollections()
      })
      return rebuild
    })
  },
})
