import type { Nuxt } from '@nuxt/schema'
import type { Nitro } from 'nitropack/types'
import type { WranglerDiagnosticPolicy } from './diagnostics'
import { defineNuxtModule, useLogger } from '@nuxt/kit'
import { resolve } from 'pathe'
import {
  diagnoseWranglerSourceConfigs,
  discoverWranglerSourceConfigs,
  evaluateWranglerDiagnostics,
} from './diagnostics'
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
  doctor?: WranglerDiagnosticPolicy
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

export function configureNitroCloudflare(
  nitro: NitroCloudflareShape,
  options: ModuleOptions,
  nuxtServerSourceMaps?: boolean,
): void {
  nitro.preset ??= 'cloudflare-module'
  nitro.cloudflare ??= {}
  nitro.cloudflare.deployConfig = true
  nitro.cloudflare.nodeCompat = true
  nitro.cloudflare.wrangler = applyCloudflareDefaults(nitro.cloudflare.wrangler ?? {}, {
    compatibilityDate: options.compatibilityDate,
    logsSampleRate: options.logsSampleRate,
    requiredSecrets: options.requiredSecrets,
    tracesSampleRate: options.tracesSampleRate,
    uploadSourceMaps: options.sourceMaps ?? nitro.sourceMap ?? nuxtServerSourceMaps ?? false,
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

async function auditGeneratedWranglerConfig(nitro: Nitro, options: ModuleOptions, rootDir: string): Promise<void> {
  const path = resolve(nitro.options.output.serverDir, 'wrangler.json')
  const result = await readWranglerJsonFile(path)
  if (result._tag === 'missing')
    throw new Error(`[nuxt-cloudflare] Generated Wrangler config is missing: ${path}`)
  if (result._tag === 'invalid')
    throw new Error(`[nuxt-cloudflare] Generated Wrangler config is invalid: ${result.reason}`)

  const diagnostics = [
    ...diagnoseWranglerConfig(result.config, {
      compatibilityMaxAgeDays: options.compatibilityMaxAgeDays,
      generated: true,
      publicVarNames: options.publicVarNames,
    }),
    ...diagnoseWranglerSourceConfigs(discoverWranglerSourceConfigs(rootDir)),
  ]
  const policy = options.doctor ?? { _tag: 'advisory' }
  const outcome = evaluateWranglerDiagnostics(diagnostics, policy)
  const blocking = new Set(outcome.blockingDiagnostics)
  const warnings = diagnostics.filter(diagnostic => diagnostic._tag === 'warning' && !blocking.has(diagnostic))
  const information = diagnostics.filter(diagnostic => diagnostic._tag === 'info')
  if (information.length > 0)
    logger.info(formatWranglerDiagnostics(information))
  if (warnings.length > 0)
    logger.warn(formatWranglerDiagnostics(warnings))
  if (outcome._tag === 'failed')
    throw new Error(`[nuxt-cloudflare]\n${formatWranglerDiagnostics(outcome.blockingDiagnostics)}`)
}

export function setupCloudflareModule(options: ModuleOptions, nuxt: Nuxt): void {
  if (!options.enabled)
    return

  const configure = () => configureNitroCloudflare(
    nuxt.options.nitro as NitroCloudflareShape,
    options,
    Boolean(nuxt.options.sourcemap.server),
  )

  configure()
  nuxt.hook('modules:done', () => {
    configure()
  })
  if (!nuxt.options.dev) {
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.hook('compiled', () => auditGeneratedWranglerConfig(nitro, options, nuxt.options.rootDir))
    })
  }
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
    doctor: { _tag: 'advisory' },
    logsSampleRate: 0.1,
    tracesSampleRate: 0.01,
    versionMetadataBinding: 'CF_VERSION_METADATA',
  },
  setup: setupCloudflareModule,
})
