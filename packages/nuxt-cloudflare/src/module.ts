import type { Nuxt } from '@nuxt/schema'
import type { Nitro } from 'nitropack/types'
import type { WranglerDiagnosticPolicy } from './diagnostics'
import type { WorkersCachePolicy } from './wrangler'
import process from 'node:process'
import { defineNuxtModule, useLogger } from '@nuxt/kit'
import { resolve } from 'pathe'
import {
  diagnoseWranglerSourceConfigs,
  discoverWranglerSourceConfigs,
  evaluateWranglerDiagnostics,
} from './diagnostics'
import { findHtmlCacheRouteRuleViolations, formatHtmlCacheRouteRuleViolations } from './html-cache'
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
  workersCache?: WorkersCachePolicy
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
  plugins?: string[]
  rollupConfig?: {
    output?: {
      banner?: string | (() => string | Promise<string>)
    }
  }
  sourceMap?: boolean
  storage?: Record<string, NitroStorageMount>
}

const logger = useLogger('nuxt-cloudflare')
const cacheDriverPath = resolve(import.meta.dirname, import.meta.url.endsWith('.ts') ? 'storage.ts' : 'storage.mjs')
const workersCachePluginPath = resolve(
  import.meta.dirname,
  import.meta.url.endsWith('.ts')
    ? 'runtime/server/plugins/workers-cache.ts'
    : 'runtime/server/plugins/workers-cache.js',
)
const BUILD_SECRET_ENV_RE = /(?:^|_)(?:API_?KEY|AUTH_TOKEN|CLIENT_SECRET|CREDENTIALS?|ENCRYPTION_KEY|PASSWORD|PRIVATE_KEY|SECRET|SIGNING_KEY|TOKEN|SALT)(?:_|$)/i
// Nuxt Scripts must resolve this value during setup to register its signed proxy plugin.
const REQUIRED_BUILD_SECRET_NAMES = new Set(['NUXT_SCRIPTS_PROXY_SECRET'])

/**
 * workerd replaces the global `console` with its Node-compatible Console the
 * moment anything in the bundle imports `node:console`. Nitro's workerd unenv
 * preset re-exports every console method from `#workerd/node:console`, so that
 * import lands in the bundle whenever a dependency touches `console` as a
 * module (undici, via node-fetch-native, is one). That Console declares
 * `createTask` but throws ERR_METHOD_NOT_IMPLEMENTED when it is called.
 *
 * `hookable` reads `typeof console.createTask !== 'undefined'` once at module
 * scope and then calls it for every hook, so a Worker built this way returns
 * 500 from every route that runs Nitro hooks. Prerendered pages are served as
 * static assets and still look fine, which is what hides it.
 *
 * The swap happens at link time, so no import ordering avoids it and a Nitro
 * plugin runs long after `hookable` captured the method. A rollup banner is the
 * only code that runs before `hookable`'s module body. Probe the method once
 * and drop it when the probe throws, so the feature detection is honest and
 * `hookable` falls back to its own task runner.
 *
 * `disable_nodejs_console_module` does not help: Nitro's preset emits the
 * `node:console` import regardless of compatibility flags, so the flag only
 * stops workerd providing the module the bundle still imports, and the Worker
 * fails to start with `No such module "node:console"`.
 *
 * Wrapped in an IIFE because a bare `var` at chunk scope collides with Terser's
 * own bindings and fails the build.
 */
export const WORKERD_CONSOLE_TASK_BANNER = ';(function(){try{var c=globalThis.console;if(c&&typeof c.createTask==="function"&&!c.__ctProbed){c.__ctProbed=1;try{c.createTask("probe")}catch(e){c.createTask=void 0}}}catch(e){}})();'

function resolveModuleWorkersCachePolicy(options: ModuleOptions): WorkersCachePolicy {
  return options.workersCache ?? { _tag: 'enabled', crossVersion: false }
}

export function findPopulatedRuntimeSecretPaths(
  config: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const paths: string[] = []
  const buildSecretValues = new Set(Object.entries(environment).flatMap(([name, value]) => {
    return BUILD_SECRET_ENV_RE.test(name)
      && !REQUIRED_BUILD_SECRET_NAMES.has(name)
      && value
      && value.length >= 8
      ? [value]
      : []
  }))
  const visit = (value: unknown, parents: string[]): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return
    for (const [key, child] of Object.entries(value)) {
      const path = [...parents, key]
      if (path[0] === 'public')
        continue
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        visit(child, path)
        continue
      }
      if (typeof child === 'string' && buildSecretValues.has(child))
        paths.push(path.join('.'))
    }
  }
  visit(config, [])
  return paths
}

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
    workersCache: resolveModuleWorkersCachePolicy(options),
  })

  nitro.rollupConfig ??= {}
  nitro.rollupConfig.output ??= {}
  const existingBanner = nitro.rollupConfig.output.banner
  if (typeof existingBanner === 'string') {
    if (!existingBanner.includes('__ctProbed')) {
      nitro.rollupConfig.output.banner = existingBanner
        ? `${existingBanner}\n${WORKERD_CONSOLE_TASK_BANNER}`
        : WORKERD_CONSOLE_TASK_BANNER
    }
  }
  else if (typeof existingBanner === 'undefined') {
    nitro.rollupConfig.output.banner = WORKERD_CONSOLE_TASK_BANNER
  }

  if (nitro.cloudflare.wrangler.cache?.enabled) {
    nitro.plugins ??= []
    if (!nitro.plugins.includes(workersCachePluginPath))
      nitro.plugins.push(workersCachePluginPath)
  }

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
  // Keep Wrangler's CLI runtime out of Nuxt module evaluation and development startup.
  const { readProjectWranglerConfig } = await import('./wrangler-reader')
  const validated = readProjectWranglerConfig({ config: path, cwd: rootDir })
  if (validated._tag === 'invalid')
    throw new Error('[nuxt-cloudflare] Generated Wrangler config fails Wrangler schema validation. Run Wrangler locally for validation details.')

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
    if (nuxt.options.dev)
      return
    const populatedRuntimeSecrets = findPopulatedRuntimeSecretPaths(nuxt.options.runtimeConfig, process.env)
    if (populatedRuntimeSecrets.length > 0) {
      throw new Error(`[nuxt-cloudflare] Runtime config contains secret build environment values: ${populatedRuntimeSecrets.join(', ')}. Keep defaults empty and use Worker secret bindings.`)
    }
  })
  nuxt.hook('nitro:config', (nitroConfig) => {
    if (resolveModuleWorkersCachePolicy(options)._tag === 'disabled')
      return
    const violations = findHtmlCacheRouteRuleViolations(nitroConfig.routeRules)
    const warnings = violations.filter(violation => violation.severity === 'warning')
    const errors = violations.filter(violation => violation.severity === 'error')
    if (warnings.length > 0)
      logger.warn(formatHtmlCacheRouteRuleViolations(warnings))
    if (errors.length > 0) {
      throw new Error(
        `[nuxt-cloudflare] HTML route rules conflict with Workers Caching:\n${formatHtmlCacheRouteRuleViolations(errors)}`,
      )
    }
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
    workersCache: { _tag: 'enabled', crossVersion: false },
  },
  setup: setupCloudflareModule,
})
