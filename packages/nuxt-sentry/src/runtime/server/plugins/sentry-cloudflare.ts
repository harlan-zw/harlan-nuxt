import type { NitroApp } from 'nitropack/types'
import type { SentryRuntimeConfig } from '../../shared/types'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore optional peer. `@sentry/cloudflare` is only resolved on a
// Cloudflare build, which is the only build that registers this plugin.
import { consoleLoggingIntegration, setContext, setTags } from '@sentry/cloudflare'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore optional peer, resolved from the site's own `@sentry/nuxt`.
import { sentryCloudflareNitroPlugin } from '@sentry/nuxt/module/plugins'
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import {
  createBeforeSend,
  createSentryDataCollection,
  resolveEnvironment,
  resolveTracesSampleRate,
} from '../../shared/policy'
import { resolveWorkerAttribution } from '../attribution'

/**
 * Server side Sentry on Cloudflare Workers.
 *
 * The default `sentry.server.config.ts` is Node based and cannot run on
 * Workers, so this Nitro plugin, backed by `@sentry/cloudflare`, is the
 * supported replacement. It wraps `nitroApp.localFetch` for per request
 * isolation and hooks Nitro's `error` event to capture unhandled errors.
 *
 * Registered by the module from inside this package, which is what lets
 * `@harlan-zw/nuxt-dx` attribute the bundle entry to `@harlan-zw/nuxt-sentry`.
 * Nothing here decides policy. Every decision is a pure function in
 * `../../shared`, and this file only calls Sentry with the result.
 */
export default defineNitroPlugin((nitroApp: NitroApp) => {
  const config = (useRuntimeConfig().public as Record<string, unknown>).nuxtSentry as SentryRuntimeConfig | undefined
  if (!config || config.target._tag !== 'enabled')
    return

  const { target, server: policy } = config
  const environment = resolveEnvironment(target.environment)

  sentryCloudflareNitroPlugin({
    dsn: target.dsn,
    environment,
    ...(target.release ? { release: target.release } : {}),
    tracesSampleRate: resolveTracesSampleRate(target.tracesSampleRate, environment),
    ...(policy.dataCollection === 'none'
      ? { dataCollection: createSentryDataCollection() }
      : { sendDefaultPii: true }),
    ...(target.logs
      ? { enableLogs: true, integrations: [consoleLoggingIntegration({ levels: ['warn', 'error'] })] }
      : {}),
    ...(target.app ? { initialScope: { tags: { app: target.app } } } : {}),
    beforeSend: createBeforeSend(policy),
  })(nitroApp)

  if (!target.workerVersionBinding)
    return

  // The isolation scope exists by the time Nitro runs request hooks, so tagging
  // here makes every request error attributable to the exact Worker version as
  // well as to its source release.
  const binding = target.workerVersionBinding
  nitroApp.hooks.hook('request', (event) => {
    const env = (event.context as { cloudflare?: { env?: Record<string, unknown> } }).cloudflare?.env
    const attribution = resolveWorkerAttribution(env?.[binding])
    if (!attribution)
      return
    setTags(attribution.tags)
    setContext('cloudflare_worker_version', attribution.context)
  })
})
