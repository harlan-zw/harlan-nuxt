import type { ContentConfig } from './config'
import type { LoadedCollection } from './core/ingest'
import type { NitroConfig } from 'nitropack/types'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  addComponent,
  addImports,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
  importModule,
  useLogger,
} from '@nuxt/kit'
import { assertSupportedOptions } from './config'
import { ingestCollections } from './core/ingest'
import { componentCandidates, componentMatchesTag } from './runtime/components/names'

export * from './config'
export type * from './runtime/types'

export interface ModuleOptions {
  database?: never
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

const layerRoot = (layer: Record<string, unknown>) => {
  const config = layer.config as Record<string, unknown> | undefined
  return String(config?.rootDir ?? layer.cwd ?? '')
}

const loadCollections = async (layers: ReadonlyArray<Record<string, unknown>>): Promise<LoadedCollection[]> => {
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
  defaults: {},
  async setup(options, nuxt) {
    assertSupportedOptions(options as Record<string, unknown>, join(nuxt.options.rootDir, 'nuxt.config.ts'))
    const resolver = createResolver(import.meta.url)
    const outputDir = join(nuxt.options.rootDir, 'node_modules/.cache/comark-content/generated')
    const cacheFile = join(nuxt.options.rootDir, '.data/comark-content/cache.json')
    const remoteCacheDir = join(nuxt.options.rootDir, 'node_modules/.cache/comark-content/git')
    const logger = useLogger('comark-content')
    const componentTags = new Set<string>()

    const componentsTemplate = addTemplate({
      filename: 'comark-content/components.mjs',
      write: true,
      getContents: ({ app }) => {
        const components = new Map(app.components.map(component => [component.pascalName, component]))
        const entries = [...componentTags].flatMap((tag) => {
          const component = componentCandidates(tag).map(name => components.get(name)).find(Boolean)
            ?? [...components.values()].find(value => componentMatchesTag(tag, value.pascalName))
          if (!component || component.filePath.endsWith('.css'))
            return []
          const importPath = isAbsolute(component.filePath)
            ? `./${relative(join(nuxt.options.buildDir, 'comark-content'), component.filePath).replaceAll('\\', '/')}`
            : component.filePath
          const exportName = component.export || 'default'
          return [`${JSON.stringify(tag)}: { name: ${JSON.stringify(component.pascalName)}, load: () => import(${JSON.stringify(importPath)}).then(module => module[${JSON.stringify(exportName)}]) }`]
        })
        return `export default {\n  ${entries.join(',\n  ')}\n}\n`
      },
    })
    nuxt.options.alias['#comark-content/components'] = componentsTemplate.dst

    nuxt.hook('components:extend', (components) => {
      for (const component of components) {
        if (![...componentTags].some(tag => componentMatchesTag(tag, component.pascalName)))
          continue
        component.global = 'sync'
      }
    })

    addComponent({ name: 'ContentRenderer', filePath: resolver.resolve('./runtime/components/ContentRenderer') })
    addImports([
      { name: 'queryCollection', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionNavigation', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionItemSurroundings', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionSearchSections', from: resolver.resolve('./runtime/client') },
    ])
    addServerHandler({ route: '/__comark_content/query', method: 'post', handler: resolver.resolve('./runtime/server/api/query.post') })

    nuxt.hook('nitro:config', (config: NitroConfig) => {
      config.serverAssets ||= []
      config.serverAssets.push({ baseName: 'comark-content', dir: outputDir })
    })

    if (nuxt.options._prepare)
      return

    const buildCollections = async () => {
      const loaded = await loadCollections(nuxt.options._layers as unknown as ReadonlyArray<Record<string, unknown>>)
      const startedAt = performance.now()
      const result = await ingestCollections(loaded, { cacheFile, remoteCacheDir })
      if (result._tag === 'Err')
        throw new Error(result.error.message, { cause: result.error.cause })
      componentTags.clear()
      for (const tag of result.value.componentTags)
        componentTags.add(tag)
      await rm(outputDir, { recursive: true, force: true })
      await mkdir(outputDir, { recursive: true })
      await Promise.all(Object.entries(result.value.collections).map(([name, items]) => writeFile(join(outputDir, `${name}.json`), JSON.stringify(items))))
      const files = Object.values(result.value.collections).reduce((sum, items) => sum + items.length, 0)
      logger.success(`Processed ${loaded.length} collections and ${files} files in ${(performance.now() - startedAt).toFixed(2)}ms (${result.value.cachedFiles} cached, ${result.value.parsedFiles} parsed)`)
    }

    nuxt.hook('modules:done', buildCollections)
    let rebuild = Promise.resolve()
    nuxt.hook('builder:watch', (event, path) => {
      if (event !== 'change' || !path.endsWith('.md'))
        return
      rebuild = rebuild.then(buildCollections)
      return rebuild
    })
  },
})
