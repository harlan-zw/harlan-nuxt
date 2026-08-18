import type { NitroApp } from 'nitropack/types'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore optional peer. Registered only on a Cloudflare build with
// `@harlan-zw/nuxt-wide-events` installed.
import { getTraceData } from '@sentry/cloudflare'
import { defineNitroPlugin } from 'nitropack/runtime'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore auto import contributed by `@harlan-zw/nuxt-wide-events`.
import { addWideEventFields } from '#imports'
import { parseSentryCorrelation } from '../wide-events'

/**
 * Write the Sentry trace identity into the request's Wide Event.
 *
 * Two fields, so a Wide Event and an Error Report for the same request can be
 * joined. Without them the two sinks hold two halves of one failure with no key
 * between them.
 *
 * The fields argument must be a single object literal. `@harlan-zw/nuxt-wide-events`
 * parses every server file at build time and rejects any other shape, so every key is
 * present on every call and `null` where the value is unavailable. The request event
 * comes first: the fields go on that request's Wide Event.
 */
export default defineNitroPlugin((nitroApp: NitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const correlation = parseSentryCorrelation(getTraceData())
    addWideEventFields(event, {
      'sentry.traceId': correlation['sentry.traceId'],
      'sentry.spanId': correlation['sentry.spanId'],
    })
  })
})
