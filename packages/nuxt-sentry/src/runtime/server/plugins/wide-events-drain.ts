import type { NitroApp } from 'nitropack/types'
import type { SentryRuntimeConfig } from '../../shared/types'
import type { DrainedWideEvent } from '../wide-events'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore optional peer. Registered only on a Cloudflare build with
// `@harlan-zw/nuxt-wide-events` installed.
import { logger } from '@sentry/cloudflare'
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { decideWideEventLog } from '../wide-events'

/**
 * Forward a failing Wide Event to Sentry Logs.
 *
 * A log, never an error. The Wide Event has no stack in production, so it could
 * not make a useful Error Report, and sending one would double count a failure
 * Sentry already captured from the same request.
 *
 * The level list is the cost control. Sentry meters Logs as its own byte quota,
 * so the drain forwards errors only until a site asks for more.
 */
export default defineNitroPlugin((nitroApp: NitroApp) => {
  const config = (useRuntimeConfig().public as Record<string, unknown>).nuxtSentry as SentryRuntimeConfig | undefined
  const drain = config?.wideEvents
  if (!drain)
    return

  // eslint-disable-next-line ts/ban-ts-comment
  // @ts-ignore the hook is declared by `@harlan-zw/nuxt-wide-events`.
  nitroApp.hooks.hook('wide-events:emit', (record: DrainedWideEvent) => {
    const decision = decideWideEventLog(record, drain)
    if (decision._tag === 'skip')
      return
    logger[decision.level](decision.message, decision.attributes)
  })
})
