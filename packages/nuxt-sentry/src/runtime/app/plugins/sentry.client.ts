import type { SentryRuntimeConfig } from '../../shared/types'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore resolved from the site's own `@sentry/nuxt`, a required peer.
import * as Sentry from '@sentry/nuxt'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore resolved by Nuxt in the consuming application.
import { defineNuxtPlugin, useRuntimeConfig } from '#app'
import {
  createBeforeSend,
  createClientNoiseOptions,
  createSentryDataCollection,
  resolveClientTarget,
  resolveEnvironment,
  resolveTracesSampleRate,
} from '../../shared/policy'

/**
 * Browser side Sentry.
 *
 * Registered by the module from inside this package, so the DSN is read from
 * `runtimeConfig` rather than repeated as a literal. One site carried a comment
 * saying its client DSN "must match" the one in `nuxt.config.ts`, which is a
 * manual invariant a shared module removes.
 *
 * `enforce: 'pre'` runs this before the application's own plugins. An error
 * thrown by the framework entry before any plugin runs is still missed, which
 * is the cost of registering from a module rather than injecting an entry file.
 */
export default defineNuxtPlugin({
  name: 'nuxt-sentry:client',
  enforce: 'pre',
  setup() {
    const config = (useRuntimeConfig().public as Record<string, unknown>).nuxtSentry as SentryRuntimeConfig | undefined
    if (!config)
      return

    const target = resolveClientTarget(config.target, window.location.hostname)
    if (target._tag !== 'enabled')
      return

    const policy = config.client
    const environment = resolveEnvironment(target.environment, window.location.hostname)
    const noise = createClientNoiseOptions(policy)

    Sentry.init({
      dsn: target.dsn,
      environment,
      ...(target.release ? { release: target.release } : {}),
      tracesSampleRate: resolveTracesSampleRate(target.tracesSampleRate, environment),
      ...(policy.dataCollection === 'none'
        ? { dataCollection: createSentryDataCollection() }
        : { sendDefaultPii: true }),
      ...(target.app ? { initialScope: { tags: { app: target.app } } } : {}),
      ignoreErrors: noise.ignoreErrors,
      denyUrls: noise.denyUrls,
      beforeSend: createBeforeSend(policy),
    })
  },
})
