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
 * ── The single object literal is load-bearing ──
 *
 * `@harlan-zw/nuxt-wide-events` parses every server file at build time and
 * REJECTS an `addWideEventFields` call whose argument is not an object literal:
 * no variables, no spreads, no computed keys. That is the guarantee the whole
 * module rests on — a reviewer can read the allowlist and know nothing else can
 * reach an event.
 *
 * So this cannot build its payload conditionally. Every key is present on every
 * call, `null` where the value is unavailable, and the whole thing is one
 * literal. An earlier version assembled a `Record` and passed the variable; it
 * failed the CONSUMING application's build, which is the worst place for a
 * module's mistake to surface.
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

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function recordCloudflareWideEventFields(event: H3Event): void {
  // Only ever these three from `request.cf`. It also carries city, region,
  // postal code and ASN — location data about a person, which has no place in a
  // record written for every request.
  const cf = (event.context as { cloudflare?: { request?: { cf?: RequestCfProperties } } })
    .cloudflare
    ?.request
    ?.cf
  const d1 = readD1Stats(event.context as unknown as Record<PropertyKey, unknown>)

  if (!cf && !d1)
    return

  addWideEventFields(event, {
    'cf.colo': stringOrNull(cf?.colo),
    'cf.country': stringOrNull(cf?.country),
    'cf.httpProtocol': stringOrNull(cf?.httpProtocol),
    'd1.queries': d1 ? d1.queries : null,
    'd1.primaryQueries': d1 ? d1.primaryQueries : null,
    'd1.recoveries': d1 ? d1.recoveries : null,
    'd1.unrecovered': d1 ? d1.unrecovered : null,
    'd1.durationMs': d1 ? Math.round(d1.durationMs) : null,
    'd1.region': d1 ? d1.region : null,
  })
}
