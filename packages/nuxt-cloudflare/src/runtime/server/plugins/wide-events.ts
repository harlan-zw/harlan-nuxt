import type { H3Event } from 'h3'
import type { NitroApp } from 'nitropack/types'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore optional peer — the module only registers this plugin when
// `@harlan-zw/nuxt-wide-events` is installed, so the specifier resolves then.
import { addWideEventFields } from '#imports'
import { readD1Stats } from '../../../d1-stats'

/**
 * Contribute Cloudflare request context to the request's Wide Event.
 *
 * Two things worth one flat record per request, neither visible from
 * application code:
 *
 * `cf.*` — which colo actually ran the isolate. A Worker's latency story is
 * mostly "where did this run relative to its data", and the colo is the only
 * field that answers it.
 *
 * `d1.*` — how many queries the request made, how many crossed to the primary
 * rather than a replica, and whether the session had to recover. A request that
 * quietly makes twenty serial primary round trips looks identical to a fast one
 * in every other log line; these counters are what separate them.
 *
 * Registered by the module only when `@harlan-zw/nuxt-wide-events` is present,
 * and the fields are declared through `addWideEventFields` at build time, so
 * the consuming application never hand-lists them and cannot drift from them.
 */
export default (nitroApp: NitroApp): void => {
  nitroApp.hooks.hook('beforeResponse', (event: H3Event) => {
    recordCloudflareWideEventFields(event)
  })
}

interface RequestCfProperties {
  colo?: unknown
  country?: unknown
  httpProtocol?: unknown
}

export function recordCloudflareWideEventFields(event: H3Event): void {
  const fields: Record<string, string | number | null> = {}

  const cf = (event.context as { cloudflare?: { request?: { cf?: RequestCfProperties } } })
    .cloudflare
    ?.request
    ?.cf
  if (cf) {
    // Only ever these three. `request.cf` also carries city, region, postal code
    // and ASN — location data about a person, which has no place in a record
    // written for every request. The allowlist upstream would reject them
    // anyway; naming the omission here so nobody adds them by reflex.
    if (typeof cf.colo === 'string')
      fields['cf.colo'] = cf.colo
    if (typeof cf.country === 'string')
      fields['cf.country'] = cf.country
    if (typeof cf.httpProtocol === 'string')
      fields['cf.httpProtocol'] = cf.httpProtocol
  }

  const d1 = readD1Stats(event.context as unknown as Record<PropertyKey, unknown>)
  if (d1) {
    fields['d1.queries'] = d1.queries
    fields['d1.primaryQueries'] = d1.primaryQueries
    fields['d1.recoveries'] = d1.recoveries
    fields['d1.unrecovered'] = d1.unrecovered
    fields['d1.durationMs'] = Math.round(d1.durationMs)
    fields['d1.region'] = d1.region
  }

  if (Object.keys(fields).length)
    addWideEventFields(event, fields)
}
