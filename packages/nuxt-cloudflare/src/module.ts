import type { Nitro } from 'nitropack/types'
import { defineNuxtModule, useLogger } from '@nuxt/kit'
import { resolve } from 'pathe'
import {
  applyCloudflareDefaults,
  diagnoseWranglerConfig,
  formatWranglerDiagnostics,
  readWranglerJsonFile,
} from './wrangler'

export interface ModuleOptions {
  enabled?: boolean
  compatibilityDate?: string
  compatibilityMaxAgeDays?: number
  kvCache?: false | {
    binding: string
    defaultTtl?: number
  }
  logsSampleRate?: number
  publicVarNames?: string[]
  requiredSecrets?: string[]
  sourceMaps?: boolean
  tracesSampleRate?: number
  versionMetadataBinding?: string
}

interface NitroStorageMount extends Record<string, unknown> {
  driver?: unknown
}

export interface NitroCloudflareShape {
  cloudflare?: {
    deployConfig?: boolean
    nodeCompat?: boolean
    wrangler?: import('./wrangler').WranglerConfigInput
  }
  preset?: string
  sourceMap?: boolean
  storage?: Record<string, NitroStorageMount>
}

const logger = useLogger('nuxt-cloudflare')
const cacheDriverPath = resolve(import.meta.dirname, import.meta.url.endsWith('.ts') ? 'storage.ts' : 'storage.mjs')

export function configureNitroCloudflare(nitro: NitroCloudflareShape, options: ModuleOptions): void {
  nitro.preset ??= 'cloudflare-module'
  nitro.cloudflare ??= {}
  nitro.cloudflare.deployConfig = true
  nitro.cloudflare.nodeCompat = true
  nitro.cloudflare.wrangler = applyCloudflareDefaults(nitro.cloudflare.wrangler ?? {}, {
    compatibilityDate: options.compatibilityDate,
    logsSampleRate: options.logsSampleRate,
    requiredSecrets: options.requiredSecrets,
    tracesSampleRate: options.tracesSampleRate,
    uploadSourceMaps: options.sourceMaps ?? nitro.sourceMap !== false,
    versionMetadataBinding: options.versionMetadataBinding,
  })

  if (options.kvCache === false)
    return

  const cache = nitro.storage?.cache
  const configuredCache = options.kvCache
  if (!configuredCache && cache?.driver !== 'cloudflare-kv-binding')
    return

  nitro.storage ??= {}
  nitro.storage.cache = {
    ...(cache ?? {}),
    ...(configuredCache ? { binding: configuredCache.binding } : {}),
    driver: cacheDriverPath,
    defaultTtl: configuredCache?.defaultTtl ?? 30 * 24 * 60 * 60,
  }
}

async function auditGeneratedWranglerConfig(nitro: Nitro, options: ModuleOptions): Promise<void> {
  const path = resolve(nitro.options.output.serverDir, 'wrangler.json')
  const result = await readWranglerJsonFile(path)
  if (result._tag === 'missing')
    throw new Error(`[nuxt-cloudflare] Generated Wrangler config is missing: ${path}`)
  if (result._tag === 'invalid')
    throw new Error(`[nuxt-cloudflare] Generated Wrangler config is invalid: ${result.reason}`)

  const diagnostics = diagnoseWranglerConfig(result.config, {
    compatibilityMaxAgeDays: options.compatibilityMaxAgeDays,
    publicVarNames: options.publicVarNames,
  })
  const warnings = diagnostics.filter(diagnostic => diagnostic._tag === 'warning')
  const errors = diagnostics.filter(diagnostic => diagnostic._tag === 'error')
  if (warnings.length > 0)
    logger.warn(formatWranglerDiagnostics(warnings))
  if (errors.length > 0)
    throw new Error(`[nuxt-cloudflare]\n${formatWranglerDiagnostics(errors)}`)
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-cloudflare',
    configKey: 'nuxtCloudflare',
    compatibility: { nuxt: '>=4.5.0' },
  },
  defaults: {
    enabled: true,
    compatibilityMaxAgeDays: 90,
    logsSampleRate: 0.1,
    tracesSampleRate: 0.01,
    versionMetadataBinding: 'CF_VERSION_METADATA',
  },
  setup(options, nuxt) {
    if (!options.enabled)
      return

    configureNitroCloudflare(nuxt.options.nitro as NitroCloudflareShape, options)
    nuxt.hook('modules:done', () => {
      configureNitroCloudflare(nuxt.options.nitro as NitroCloudflareShape, options)
    })
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.hook('compiled', () => auditGeneratedWranglerConfig(nitro, options))
    })
  },
})
