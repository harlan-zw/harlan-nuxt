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
 * So this cannot build its payload conditionally. Every key is present in the
 * source literal. The Wide Events transform removes `undefined` values at
 * runtime. An earlier version assembled a `Record` and passed the variable; it
 * failed the consuming application's build.
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

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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
    'cf.colo': stringOrUndefined(cf?.colo),
    'cf.country': stringOrUndefined(cf?.country),
    'cf.httpProtocol': stringOrUndefined(cf?.httpProtocol),
    'd1.queries': d1?.queries,
    'd1.primaryQueries': d1?.primaryQueries,
    'd1.recoveries': d1?.recoveries,
    'd1.unrecovered': d1?.unrecovered,
    'd1.durationMs': d1 ? Math.round(d1.durationMs) : undefined,
    'd1.region': d1?.region ?? undefined,
  })
}
