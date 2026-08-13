import type { ModuleOptions } from './types'
import { addServerImports, addServerPlugin, addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import { formatWideEventFieldIssues, resolveWideEventFields } from './build/fields'
import { resolveWideEventsRuntimeConfig, serializeWideEventsRuntimeConfig } from './build/runtime-config'
import { createWideEventValidationPlugin } from './build/source-scan'

export type { ModuleOptions } from './types'

interface NitroConfigLike {
  alias?: Record<string, string>
  rollupConfig?: {
    plugins?: ReturnType<typeof createWideEventValidationPlugin>[]
  }
}

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
    request: true,
    fields: [],
    console: true,
    drain: false,
  },
  setup(options, nuxt) {
    if (!options.enabled)
      return

    const resolvedFields = resolveWideEventFields(options.fields ?? [])
    if (resolvedFields._tag === 'Err')
      throw new Error(`[nuxt-wide-events]\n${formatWideEventFieldIssues(resolvedFields.issues)}`)

    const fields = new Set(resolvedFields.fields)
    const resolver = createResolver(import.meta.url)
    const runtimeConfig = resolveWideEventsRuntimeConfig(options)
    const configTemplate = addTemplate({
      filename: 'wide-events/config.mjs',
      write: true,
      getContents: () => serializeWideEventsRuntimeConfig(runtimeConfig),
    })
    nuxt.options.alias['#wide-events/config'] = configTemplate.dst
    const nitro = ((nuxt.options as unknown as { nitro?: NitroConfigLike }).nitro ??= {})
    nitro.alias ||= {}
    nitro.alias['#wide-events/config'] = configTemplate.dst
    nitro.rollupConfig ||= {}
    nitro.rollupConfig.plugins ||= []
    nitro.rollupConfig.plugins.push(createWideEventValidationPlugin(nuxt.options.rootDir, fields))

    if (options.request ?? true) {
      addServerPlugin(resolver.resolve(nuxt.options.dev
        ? './runtime/server/development-plugin'
        : runtimeConfig.exclude || runtimeConfig.sampling
          ? './runtime/server/production-policy-plugin'
          : './runtime/server/production-plugin'))
    }
    addServerImports({
      name: 'addWideEventFields',
      from: resolver.resolve('./runtime/server/index'),
    })
    addServerImports({
      name: 'createWideEvent',
      from: resolver.resolve(runtimeConfig.drain
        ? './runtime/server/standalone-drain'
        : nuxt.options.dev
          ? './runtime/server/standalone-development'
          : './runtime/server/standalone-production'),
    })
    addWideEventTypes(resolvedFields.fields)
  },
})

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
  }, { nuxt: true, nitro: true })
}
