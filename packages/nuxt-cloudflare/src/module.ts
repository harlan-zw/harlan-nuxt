import type { Nuxt } from '@nuxt/schema'
import type { Nitro } from 'nitropack/types'
import type { WranglerDiagnosticPolicy } from './diagnostics'
import type { WorkersCachePolicy } from './wrangler'
import process from 'node:process'
import { addTypeTemplate, defineNuxtModule, hasNuxtModule, useLogger } from '@nuxt/kit'
import { resolve } from 'pathe'
import {
  diagnoseWranglerSourceConfigs,
  discoverWranglerSourceConfigs,
  evaluateWranglerDiagnostics,
} from './diagnostics'
import { findHtmlCacheRouteRuleViolations, formatHtmlCacheRouteRuleViolations } from './html-cache'
import { resolveHtmlCacheGuarantee, staleDirectivesAreDisabled } from './runtime/server/utils/workers-cache'
import {
  applyCloudflareDefaults,
  diagnoseWranglerConfig,
  formatWranglerDiagnostics,
  readAuthoredWranglerConfig,
  readWranglerJsonFile,
} from './wrangler'

export interface ModuleOptions {
  bindingTypes?: boolean
  enabled?: boolean
  compatibilityDate?: string
  compatibilityMaxAgeDays?: number
  doctor?: WranglerDiagnosticPolicy
  kvCache?: false | {
    binding: string
    defaultTtl?: number
  }
  logsSampleRate?: number
  partialBundles?: boolean
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
const wideEventsPluginPath = resolve(
  import.meta.dirname,
  import.meta.url.endsWith('.ts')
    ? 'runtime/server/plugins/wide-events.ts'
    : 'runtime/server/plugins/wide-events.js',
)
const runtimeConfigPluginPath = resolve(
  import.meta.dirname,
  import.meta.url.endsWith('.ts')
    ? 'runtime/server/plugins/runtime-config.ts'
    : 'runtime/server/plugins/runtime-config.js',
)

/**
 * Cloudflare context worth one flat record per request.
 *
 * Declared here so the consuming application never hand-lists them: this module
 * knows what it populates, and `addWideEventFields` is what lets it say so.
 * Deliberately excludes everything in `request.cf` that describes a PERSON —
 * city, region, postal code, ASN — see the plugin.
 */
const WIDE_EVENT_FIELDS = [
  'cf.colo',
  'cf.country',
  'cf.httpProtocol',
  'd1.durationMs',
  'd1.primaryQueries',
  'd1.queries',
  'd1.recoveries',
  'd1.region',
  'd1.unrecovered',
] as const
const BUILD_SECRET_ENV_RE = /(?:^|_)(?:API_?KEY|AUTH_TOKEN|CLIENT_SECRET|CREDENTIALS?|ENCRYPTION_KEY|PASSWORD|PRIVATE_KEY|SECRET|SIGNING_KEY|TOKEN|SALT)(?:_|$)/i
// Nuxt Scripts must resolve this value during setup to register its signed proxy plugin.
const REQUIRED_BUILD_SECRET_NAMES = new Set(['NUXT_SCRIPTS_PROXY_SECRET'])

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

export interface NitroCloudflareContext {
  /** The project directory Wrangler and Nitro read the authored config from. */
  rootDir?: string
  /** Whether Nuxt emits server source maps. */
  serverSourceMaps?: boolean
}

function addNitroPlugin(nitro: NitroCloudflareShape, path: string): void {
  nitro.plugins ??= []
  if (!nitro.plugins.includes(path))
    nitro.plugins.push(path)
}

export function configureNitroCloudflare(
  nitro: NitroCloudflareShape,
  options: ModuleOptions,
  context: NitroCloudflareContext = {},
): void {
  const authored = readAuthoredWranglerConfig(context.rootDir)
  if (authored._tag === 'invalid')
    throw new Error(`[nuxt-cloudflare] Wrangler config "${authored.path}" cannot be parsed: ${authored.reason}`)

  nitro.preset ??= 'cloudflare-module'
  nitro.cloudflare ??= {}
  nitro.cloudflare.deployConfig = true
  nitro.cloudflare.nodeCompat = true
  nitro.cloudflare.wrangler = applyCloudflareDefaults(nitro.cloudflare.wrangler ?? {}, {
    compatibilityDate: options.compatibilityDate,
    logsSampleRate: options.logsSampleRate,
    partialBundles: options.partialBundles,
    requiredSecrets: options.requiredSecrets,
    tracesSampleRate: options.tracesSampleRate,
    uploadSourceMaps: options.sourceMaps ?? nitro.sourceMap ?? context.serverSourceMaps ?? false,
    versionMetadataBinding: options.versionMetadataBinding,
    workersCache: resolveModuleWorkersCachePolicy(options),
  }, authored._tag === 'authored' ? authored.config : {})

  addNitroPlugin(nitro, runtimeConfigPluginPath)

  if (nitro.cloudflare.wrangler.cache?.enabled)
    addNitroPlugin(nitro, workersCachePluginPath)

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

export type BindingTypeAudit
  = | { _tag: 'compare', signature: string }
    | { _tag: 'missing' }
    | { _tag: 'skipped' }

/**
 * Decides whether the build compares generated binding types with the final
 * Wrangler config.
 *
 * The signature exists only after the type template regenerates. A build that
 * reuses a cached template must fail, not skip: a skipped comparison reports a
 * clean build for types that no longer match the deployed config.
 */
export function resolveBindingTypeAudit(
  bindingTypes: boolean | undefined,
  signature: string | undefined,
): BindingTypeAudit {
  if (bindingTypes === false)
    return { _tag: 'skipped' }
  return signature ? { _tag: 'compare', signature } : { _tag: 'missing' }
}

async function auditGeneratedWranglerConfig(
  nitro: Nitro,
  options: ModuleOptions,
  buildDir: string,
  rootDir: string,
  bindingTypeSignature?: string,
): Promise<void> {
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

  const audit = resolveBindingTypeAudit(options.bindingTypes, bindingTypeSignature)
  if (audit._tag === 'missing') {
    throw new Error(
      '[nuxt-cloudflare] Cloudflare binding types were not generated during this build, so the drift check could not run. Run `nuxt prepare`, or set `bindingTypes: false` when another tool owns the declaration.',
    )
  }
  if (audit._tag === 'compare') {
    const { assertCloudflareBindingTypesCurrent } = await import('./binding-types')
    await assertCloudflareBindingTypesCurrent({
      buildDir,
      compatibilityDate: result.config.compatibility_date,
      config: result.config,
      expectedSignature: audit.signature,
      nodeCompat: Boolean(nitro.options.cloudflare?.nodeCompat),
    })
  }

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
    {
      rootDir: nuxt.options.rootDir,
      serverSourceMaps: Boolean(nuxt.options.sourcemap.server),
    },
  )

  // Optional integration with `@harlan-zw/nuxt-wide-events`. Declaring the
  // fields is not optional decoration: that module's build plugin rejects any
  // `addWideEventFields` call naming a field the allowlist does not carry, so
  // without this the server plugin below would fail the application's build.
  //
  // A hook, so this module needs no import from and no dependency on that one.
  // When it is absent the hook never fires and this is inert.
  // The hook name and this registry shape are the contract with that module.
  // Typed structurally and called through a narrow cast rather than importing
  // its `@nuxt/schema` augmentation: that augmentation is the one place the
  // hook may be declared — two packages declaring the same hook key must give
  // it an identical type or TypeScript rejects the merge — and importing it
  // would give this module the dependency the hook exists to avoid.
  const registerWideEventFields = nuxt.hook as unknown as (
    name: 'wide-events:fields',
    callback: (registry: { add: (moduleName: string, fields: readonly string[]) => void }) => void,
  ) => void
  registerWideEventFields('wide-events:fields', (registry) => {
    registry.add('@harlan-zw/nuxt-cloudflare', [...WIDE_EVENT_FIELDS])
  })

  // The plugin itself only resolves `addWideEventFields` when that module is
  // installed, so it is registered only then.
  // `hasNuxtModule` reads `nuxt.options.modules` without checking it, so guard
  // the array first: this function is exported and called directly with partial
  // Nuxt objects, and a detection helper must not be the thing that throws.
  if (Array.isArray(nuxt.options.modules) && hasNuxtModule('@harlan-zw/nuxt-wide-events', nuxt)) {
    addNitroPlugin(nuxt.options.nitro as NitroCloudflareShape, wideEventsPluginPath)
  }

  let bindingTypeSignature: string | undefined

  if (options.bindingTypes !== false) {
    const bindingTypesTemplate = addTypeTemplate({
      filename: 'types/cloudflare-bindings.d.ts',
      getContents: async () => {
        const { prepareCloudflareBindingTypes } = await import('./binding-types')
        const compatibilityDate = nuxt.options.compatibilityDate
        const artifact = await prepareCloudflareBindingTypes({
          buildDir: nuxt.options.buildDir,
          compatibilityDate: typeof compatibilityDate === 'string'
            ? compatibilityDate || undefined
            : compatibilityDate.cloudflare ?? compatibilityDate.default,
          nodeCompat: Boolean((nuxt.options.nitro as NitroCloudflareShape).cloudflare?.nodeCompat),
          rootDir: nuxt.options.rootDir,
          wrangler: (nuxt.options.nitro as NitroCloudflareShape).cloudflare?.wrangler ?? {},
        })
        bindingTypeSignature = artifact.signature
        return artifact.content
      },
    }, { nitro: true })
    nuxt.hook('prepare:types', ({ references }) => {
      references.push({ path: bindingTypesTemplate.dst })
    })
  }

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
    const policy = resolveModuleWorkersCachePolicy(options)
    if (policy._tag === 'disabled')
      return

    const mode = policy.html ?? 'auto'
    // Read at `nitro:config`, which runs after `modules:done`, so every module
    // that publishes a capability during its own `setup` has already done so.
    const guarantee = resolveHtmlCacheGuarantee(nuxt.options.runtimeConfig.htmlCacheCapabilities)

    nuxt.options.runtimeConfig.nuxtCloudflare = {
      ...(typeof nuxt.options.runtimeConfig.nuxtCloudflare === 'object'
        ? nuxt.options.runtimeConfig.nuxtCloudflare
        : {}),
      htmlCacheMode: mode,
    }

    // The single highest-value line here. The default is invisible until it
    // costs someone an afternoon, so state it before that happens.
    if (mode === 'app') {
      logger.info('Workers Cache honours your HTML cache rules. You own the version-skew risk.')
    }
    else if (guarantee._tag === 'bounded' && mode === 'auto') {
      logger.info(`${guarantee.by} guarantees chunks for ${guarantee.ceilingSeconds}s. Workers Cache honours your HTML cache rules up to that limit.`)
    }
    else {
      logger.info('Workers Cache is on. HTML documents get `private, no-store`. A module must guarantee chunk retention to change this.')
    }

    // The assertion the app is making by writing a shared-cache rule on a
    // document route, said out loud once so it is an informed one. This module
    // will not invent a `Vary`, because inventing one costs every route that
    // does not negotiate and hides the bug on the ones that do.
    if (mode === 'app' || guarantee._tag === 'bounded')
      logger.info('A shared cache keys on the URL. If a page changes with a request header, set `Vary` on it. Responses varying on Cookie or Authorization are never shared.')

    // The trap every site that hand-wrote this policy left a comment about.
    // Cloudflare reads `s-maxage` as implying `proxy-revalidate`, so pairing it
    // with a stale directive silently does nothing.
    for (const [route, rule] of Object.entries(nitroConfig.routeRules ?? {})) {
      const headers = (rule as { headers?: Record<string, string> } | undefined)?.headers
      if (!headers)
        continue
      for (const [name, value] of Object.entries(headers)) {
        if (!name.toLowerCase().endsWith('cache-control'))
          continue
        if (staleDirectivesAreDisabled(value))
          logger.warn(`routeRules['${route}'] sets \`${name}: ${value}\`. Cloudflare disables stale serving when \`s-maxage\`, \`must-revalidate\` or \`proxy-revalidate\` is present. Use \`max-age\` for the edge freshness window instead.`)
      }
    }

    // A guarantee answers one hazard: a cached document naming chunks a deploy
    // deleted. It does not answer the others, so the validator still runs.
    //
    // What a guarantee does change is the severity of a plain header rule,
    // because the runtime can clamp that one. Everything the runtime cannot
    // reach stays an error however good the guarantee is:
    //
    // - `prerender: true` routes have their headers written into `_headers` and
    //   are served by Workers Assets, so the Worker never runs and never clamps.
    // - `cache` / `swr` / `isr` wrap the handler in nitro's own cache, which
    //   keys on the path alone and replays a stored `Set-Cookie` to everyone.
    //   No header policy can undo that.
    const relaxable = mode === 'app' || guarantee._tag === 'bounded'
    const violations = findHtmlCacheRouteRuleViolations(nitroConfig.routeRules)
      .filter(violation => !(relaxable && violation._tag === 'html-cache-header'))
    const warnings = violations.filter(violation => violation.severity === 'warning')
    const errors = violations.filter(violation => violation.severity === 'error')
    if (warnings.length > 0)
      logger.warn(formatHtmlCacheRouteRuleViolations(warnings))
    if (errors.length > 0) {
      throw new Error(
        `[nuxt-cloudflare] HTML route rules conflict with Workers Caching:\n${formatHtmlCacheRouteRuleViolations(errors)}\nA chunk-retention guarantee does not cover these. A prerendered route is served by Workers Assets, and a cache/swr/isr rule stores the response in nitro's own path-keyed cache. Use a plain \`cache-control\` header rule instead, or set \`nuxtCloudflare.workersCache.html: 'app'\` to own the risk.`,
      )
    }
  })
  if (!nuxt.options.dev) {
    nuxt.hook('nitro:init', (nitro) => {
      // Only nitro's Cloudflare presets write the config this audits. On any
      // other preset there is nothing to check, and throwing over its absence
      // fails a build that is otherwise fine.
      if (!nitro.options.preset?.includes('cloudflare'))
        return
      nitro.hooks.hook('compiled', () => auditGeneratedWranglerConfig(
        nitro,
        options,
        nuxt.options.buildDir,
        nuxt.options.rootDir,
        bindingTypeSignature,
      ))
    })
  }
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-cloudflare',
    configKey: 'nuxtCloudflare',
    compatibility: { nuxt: '>=4.5.0 <6.0.0' },
  },
  defaults: {
    bindingTypes: true,
    enabled: true,
    compatibilityMaxAgeDays: 90,
    doctor: { _tag: 'advisory' },
    logsSampleRate: 0.01,
    partialBundles: true,
    tracesSampleRate: 0.01,
    versionMetadataBinding: 'CF_VERSION_METADATA',
    workersCache: { _tag: 'enabled', crossVersion: false },
  },
  setup: setupCloudflareModule,
})
