import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions, WideEventsRuntimeConfig } from './types'
import { addServerImports, addServerPlugin, addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import { join, normalize } from 'pathe'
import { formatWideEventFieldIssues, resolveWideEventFields } from './build/fields'
import { assertWideEventSourceFile, assertWideEventSources, isWideEventSourceFile } from './build/source-scan'

export type { ModuleOptions } from './types'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-wide-events',
    configKey: 'wideEvents',
    compatibility: {
      nuxt: '>=4.5.0 <5.0.0',
    },
  },
  defaults: {
    enabled: true,
    fields: [],
    console: true,
  },
  setup(options, nuxt) {
    if (!options.enabled)
      return

    const resolvedFields = resolveWideEventFields(options.fields ?? [])
    if (resolvedFields._tag === 'Err')
      throw new Error(`[nuxt-wide-events]\n${formatWideEventFieldIssues(resolvedFields.issues)}`)

    const fields = new Set(resolvedFields.fields)
    const roots = serverRoots(nuxt)
    const resolver = createResolver(import.meta.url)
    const runtimeConfig: WideEventsRuntimeConfig = {
      console: options.console ?? true,
      ...(options.service === undefined ? {} : { service: options.service }),
    }
    const configTemplate = addTemplate({
      filename: 'wide-events/config.mjs',
      write: true,
      getContents: () => `export default ${JSON.stringify(runtimeConfig)}\n`,
    })
    nuxt.options.alias['#wide-events/config'] = configTemplate.dst
    const nitro = ((nuxt.options as unknown as { nitro?: { alias?: Record<string, string> } }).nitro ??= {})
    nitro.alias ||= {}
    nitro.alias['#wide-events/config'] = configTemplate.dst

    addServerPlugin(resolver.resolve(nuxt.options.dev
      ? './runtime/server/development-plugin'
      : './runtime/server/production-plugin'))
    addServerImports({
      name: 'addWideEventFields',
      from: resolver.resolve('./runtime/server/index'),
    })
    addWideEventTypes(resolvedFields.fields)

    nuxt.hook('modules:done', async () => {
      await assertWideEventSources(nuxt.options.rootDir, roots, fields)
    })
    nuxt.hook('builder:watch' as never, (async (_event: string, file: string) => {
      if (isWideEventSourceFile(file, roots))
        await assertWideEventSourceFile(nuxt.options.rootDir, file, fields)
    }) as never)
  },
})

function serverRoots(nuxt: Nuxt): string[] {
  return [...new Set(nuxt.options._layers.map(layer => normalize(join(layer.config.rootDir, 'server'))))]
}

function addWideEventTypes(fields: readonly string[]): void {
  const properties = fields.map(field => `    '${field}': true`).join('\n')
  addTypeTemplate({
    filename: 'wide-events/fields.d.ts',
    getContents: () => `
declare global {
  interface NuxtWideEventFields {
${properties}
  }
}

export {}
`,
  }, { nuxt: true, nitro: true })

  addTypeTemplate({
    filename: 'wide-events/hooks.d.ts',
    getContents: () => `
import type { WideEventRecord } from '@harlan-zw/nuxt-wide-events/server'

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'wide-events:emit': (record: WideEventRecord) => void | Promise<void>
  }
}

export {}
`,
  }, { nitro: true })
}
