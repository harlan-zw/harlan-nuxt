import type { Nuxt } from '@nuxt/schema'
import type { SentryRuntimeConfig } from './runtime/shared/types'
import type { ModuleOptions } from './types'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { addPlugin, addServerPlugin, createResolver, defineNuxtModule, hasNuxtModule, useLogger } from '@nuxt/kit'
import { resolve } from 'pathe'
import { resolveReportPolicy } from './build/policy'
import { checkSentryBuild, hasSentryAuthToken, resolveSentryBuildOptions } from './build/sentry-build'
import { resolveRelease, resolveReportTarget } from './build/target'

export type { ModuleOptions } from './types'

const MODULE_NAME = '@harlan-zw/nuxt-sentry'

/** Wide Event fields this module populates, so the allowlist stays exhaustive. */
const WIDE_EVENT_FIELDS = ['sentry.traceId', 'sentry.spanId'] as const

interface NitroConfigLike {
  preset?: string
  plugins?: string[]
}

/**
 * A Cloudflare Workers preset needs `@sentry/cloudflare`, which the Node SDK
 * cannot replace and which cannot be bundled into a Node build.
 */
function isCloudflarePreset(preset: string | undefined): boolean {
  return Boolean(preset?.startsWith('cloudflare'))
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    // Declared so `@harlan-zw/nuxt-dx` attributes the registered plugins to
    // this package. Today every site registers an anonymous
    // `server/plugins/sentry.ts`, so the bundle entry has no owner and the
    // size budget override has to be copied into each app.
    name: MODULE_NAME,
    configKey: 'nuxtSentry',
    compatibility: { nuxt: '>=4.5.0 <5.0.0' },
  },
  defaults: {
    enabled: true,
    dsn: '',
    org: 'harlan-zw',
    // A release identity is the proof that a deploy produced this build.
    // `nuxt preview` and `wrangler dev` both run a production build with
    // NODE_ENV=production, so NODE_ENV alone let a laptop file issues against
    // the live project.
    gate: 'release',
    environment: 'production',
    tracesSampleRate: 0.05,
    // Richer reports, then redaction. The Redaction Rules are what make this
    // safe, and they run on every report under both settings.
    dataCollection: 'scrubbed',
    sourceMaps: true,
    logs: false,
    workerVersionBinding: 'CF_VERSION_METADATA',
    wideEvents: false,
  },
  setup(options, nuxt) {
    const logger = useLogger(MODULE_NAME)
    if (options.enabled === false)
      return

    const resolver = createResolver(import.meta.url)
    const env = {
      nodeEnv: process.env.NODE_ENV,
      sentryRelease: process.env.SENTRY_RELEASE,
      githubSha: process.env.GITHUB_SHA,
      vercelGitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA,
      sentryEnvironment: process.env.SENTRY_ENVIRONMENT,
      ci: process.env.CI,
    }

    const target = resolveReportTarget({
      enabled: true,
      dsn: options.dsn ?? '',
      gate: options.gate ?? 'release',
      environment: options.environment ?? 'production',
      tracesSampleRate: options.tracesSampleRate ?? 0.05,
      app: options.app,
      logs: options.logs ?? false,
      workerVersionBinding: options.workerVersionBinding ?? 'CF_VERSION_METADATA',
      env,
    })

    // Nothing to configure without a DSN, and warning about a release the site
    // never asked for would be noise. `enabled: false` took the same road above.
    if (target._tag === 'disabled' && target.reason === 'no-dsn') {
      logger.info('No nuxtSentry.dsn is set, so no Error Report is sent and no Sentry build option is written.')
      return
    }

    const dataCollection = options.dataCollection ?? 'scrubbed'
    const runtime: SentryRuntimeConfig = {
      target,
      client: resolveReportPolicy({ scope: 'client', dataCollection, options: options.policy ?? {} }),
      server: resolveReportPolicy({ scope: 'server', dataCollection, options: options.policy ?? {} }),
    }

    // Public, because the client plugin reads it. Nothing here is a secret: the
    // DSN ships in the browser bundle by design, and the policy is a rule list.
    const publicConfig = nuxt.options.runtimeConfig.public as Record<string, unknown>
    publicConfig.nuxtSentry = runtime

    const sourceMaps = options.sourceMaps ?? true
    const authTokenPresent = hasSentryAuthToken({
      sentryAuthToken: process.env.SENTRY_AUTH_TOKEN,
      hasDotenvFile: existsSync(resolve(nuxt.options.rootDir, '.env.sentry-build-plugin')),
    })
    const release = resolveRelease(env)

    for (const issue of checkSentryBuild({
      sourceMaps,
      hasAuthToken: authTokenPresent,
      project: options.project,
      release,
      gate: options.gate ?? 'release',
      isProduction: env.nodeEnv === 'production',
    })) {
      if (issue._tag === 'error')
        throw new Error(`[${MODULE_NAME}] ${issue.message}`)
      logger.warn(issue.message)
    }

    // `@sentry/nuxt/module` still owns the build plugin, the source map upload
    // and the client entry injection. This module only decides its settings.
    const nuxtOptions = nuxt.options as unknown as { sentry?: Record<string, unknown> }
    nuxtOptions.sentry = {
      ...resolveSentryBuildOptions({
        org: options.org ?? 'harlan-zw',
        project: options.project,
        release,
        sourceMaps,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        hasAuthToken: authTokenPresent,
      }),
      ...nuxtOptions.sentry,
    }

    if (sourceMaps && authTokenPresent) {
      // `hidden` emits the map and keeps the comment out of the served bundle.
      // `sourcemap.server` is left alone: `@harlan-zw/nuxt-cloudflare` derives
      // `upload_source_maps` from it, and turning it on here would change a
      // Wrangler file this module does not own.
      nuxt.options.sourcemap.client = 'hidden'
    }

    if (target._tag === 'disabled') {
      logger.info(`No Error Report is sent from this build. ${describeReason(target.reason)}`)
      return
    }

    addPlugin({ src: resolver.resolve('./runtime/app/plugins/sentry.client'), mode: 'client' })

    const nitro = ((nuxt.options as unknown as { nitro?: NitroConfigLike }).nitro ??= {})
    const cloudflare = isCloudflarePreset(nitro.preset)
    if (cloudflare) {
      addServerPlugin(resolver.resolve('./runtime/server/plugins/sentry-cloudflare'))
    }
    else {
      logger.warn('The Nitro preset is not a Cloudflare one, so this module registers no server plugin. Keep the site\'s own sentry.server.config.ts and build it with createBeforeSend from @harlan-zw/nuxt-sentry/server.')
    }

    registerWideEvents(nuxt, options, resolver, cloudflare)
  },
})

function describeReason(reason: string): string {
  switch (reason) {
    case 'no-dsn':
      return 'No nuxtSentry.dsn is set.'
    case 'not-production':
      return 'This build is not a production build.'
    case 'no-release':
      return 'This build carries no release identity. Set SENTRY_RELEASE in the deploy workflow, or set nuxtSentry.gate to "always".'
    case 'not-ci':
      return 'This build was not produced in CI.'
    default:
      return ''
  }
}

/**
 * Wire the two directions this module shares with `@harlan-zw/nuxt-wide-events`.
 *
 * Neither package imports the other. The field declaration goes through the
 * `wide-events:fields` build hook, which never fires when that module is
 * absent, and the drain plugin is registered only when it is present.
 */
function registerWideEvents(
  nuxt: Nuxt,
  options: ModuleOptions,
  resolver: ReturnType<typeof createResolver>,
  cloudflare: boolean,
): void {
  const declareFields = nuxt.hook as unknown as (
    name: 'wide-events:fields',
    callback: (registry: { add: (moduleName: string, fields: readonly string[]) => void }) => void,
  ) => void
  declareFields('wide-events:fields', (registry) => {
    registry.add(MODULE_NAME, [...WIDE_EVENT_FIELDS])
  })

  // Both plugins read the Sentry trace through `@sentry/cloudflare`, so they
  // only resolve on a Cloudflare build.
  if (!cloudflare)
    return
  // `hasNuxtModule` reads `nuxt.options.modules` without checking it first.
  if (!Array.isArray(nuxt.options.modules) || !hasNuxtModule('@harlan-zw/nuxt-wide-events', nuxt))
    return

  addServerPlugin(resolver.resolve('./runtime/server/plugins/wide-events-correlation'))
  if (options.wideEvents)
    addServerPlugin(resolver.resolve('./runtime/server/plugins/wide-events-drain'))
}
