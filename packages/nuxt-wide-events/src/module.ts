import type { WideEventFieldRegistry } from './build/contributed-fields'
import type { ModuleOptions } from './types'
import { addServerImports, addServerPlugin, addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import { createWideEventFieldRegistry } from './build/contributed-fields'
import { formatWideEventFieldIssues, resolveWideEventFields } from './build/fields'
import { resolveWideEventsRuntimeConfig, serializeWideEventsRuntimeConfig } from './build/runtime-config'
import { createWideEventValidationPlugin } from './build/source-scan'

export type { ModuleOptions } from './types'

declare module '@nuxt/schema' {
  interface NuxtHooks {
    /**
     * Declare Wide Event fields a module populates at runtime.
     *
     * Fired once at `modules:done`, so a listener registered from any module's
     * `setup` is collected regardless of module order. Registering a listener
     * when this module is absent is inert — the hook never fires — which is what
     * lets a module integrate optionally and without a dependency.
     */
    'wide-events:fields': (registry: WideEventFieldRegistry) => void | Promise<void>
  }
}

const STANDALONE_EXPORT = '@harlan-zw/nuxt-wide-events/standalone'

interface NitroConfigLike {
  alias?: Record<string, string>
  rollupConfig?: {
    plugins?: ReturnType<typeof createWideEventValidationPlugin>[]
  }
  typescript?: {
    tsConfig?: {
      compilerOptions?: {
        paths?: Record<string, string[]>
      }
    }
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
    drain: false,
  },
  setup(options, nuxt) {
    // A disabled module keeps every server import, so `addWideEventFields` and
    // `createWideEvent` still resolve. It stops output instead.
    const enabled = options.enabled ?? true

    // Resolved at `modules:done`, not here, so a module contributing fields
    // through `addWideEventFields` is treated the same whether it sets up
    // before or after this one. Both consumers of the resolved list — the
    // rollup validation plugin and the generated types — are read later than
    // this hook fires, so deferring costs nothing.
    const fields = new Set<string>()
    const resolver = createResolver(import.meta.url)
    nuxt.hook('modules:done', async () => {
      const collected = createWideEventFieldRegistry()
      await nuxt.callHook('wide-events:fields', collected.registry)
      const resolvedFields = resolveWideEventFields([
        ...(options.fields ?? []),
        ...collected.fields,
      ])
      if (resolvedFields._tag === 'Err')
        throw new Error(`[nuxt-wide-events]\n${formatWideEventFieldIssues(resolvedFields.issues)}`)
      for (const field of resolvedFields.fields)
        fields.add(field)
      addWideEventTypes(resolvedFields.fields)
    })
    const runtimeConfig = resolveWideEventsRuntimeConfig(enabled
      ? options
      : { ...options, console: false, drain: false })
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

    if (enabled && (options.request ?? true)) {
      addServerPlugin(resolver.resolve(nuxt.options.dev
        ? './runtime/server/development-plugin'
        : runtimeConfig.exclude || runtimeConfig.sampling
          ? './runtime/server/production-policy-plugin'
          : './runtime/server/production-plugin'))
    }
    addServerImports([
      { name: 'addWideEventFields', from: resolver.resolve('./runtime/server/index') },
      { name: 'setWideEventLevel', from: resolver.resolve('./runtime/server/index') },
    ])

    // One implementation inside Nitro. A deep import of `/standalone` would
    // otherwise drop `service`, `console`, `sampling`, and `drain`.
    const standalone = resolver.resolve(runtimeConfig.drain
      ? './runtime/server/standalone-drain'
      : nuxt.options.dev
        ? './runtime/server/standalone-development'
        : './runtime/server/standalone-production')
    addServerImports({ name: 'createWideEvent', from: standalone })
    nitro.alias[STANDALONE_EXPORT] = standalone
    const tsConfig = (nitro.typescript ??= {}).tsConfig ??= {}
    const compilerOptions = tsConfig.compilerOptions ??= {}
    ;(compilerOptions.paths ??= {})[STANDALONE_EXPORT] = [standalone]
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
import type { BackgroundWideEventRecord, WideEventRecord } from '@harlan-zw/nuxt-wide-events/server'

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'wide-events:emit': (record: BackgroundWideEventRecord | WideEventRecord) => void | Promise<void>
  }
}

export {}
`,
  }, { nuxt: true, nitro: true })
}
