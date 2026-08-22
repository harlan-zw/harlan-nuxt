# @harlan-zw/nuxt-cloudflare

Opinionated Cloudflare defaults and deploy diagnostics for Nuxt 4.

The module extracts production patterns already proven in Nuxt SEO and gscdump. It intentionally owns platform policy, not application topology.

## Defaults

Every default below yields to a value you wrote. The root `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` is authored config, and so is `nitro.cloudflare.wrangler`. A module default applies only where neither names the key. Workers Caching is the one exception: the module owns that policy because it also registers the caching plugin.

- Cloudflare module preset, generated Wrangler config, and Node compatibility
- Static assets remain asset first by default. Blanket `assets.run_worker_first: true` warns because valid authentication and transform use cases exist
- Workers Logs sampled at 1%, traces at 1%, both overridable
- Preview URLs disabled unless explicitly enabled
- `workers_dev` disabled when a route proves the Worker remains reachable; workers without routes must choose explicitly
- Version metadata binding at `CF_VERSION_METADATA`
- Smart Placement enabled unless the project chooses a placement
- Partial bundling: `find_additional_modules` plus a fallthrough `ESModule` rule for `**/*.mjs`, unless a rule already covers mjs or `no_bundle` is set
- Workers Caching enabled with version isolation
- Rendered HTML forced to `private, no-store`; explicit non-HTML cache policies remain intact
- Source-map upload when the Nitro build emits maps; an authored value is preserved
- `nodejs_compat` added unless the config chooses `nodejs_compat_v2`, which Cloudflare rejects alongside it
- Module-wide `secrets.required` names copied to each environment; source root secrets remain scoped to the root
- Version metadata is skipped when `CF_VERSION_METADATA` already names another binding
- Raw `cloudflare-kv-binding` on Nitro's `cache` mount upgraded to a 30-day physical expiry
- Final generated Wrangler config validated through Wrangler, then audited after production Nitro compiles
- Production builds fail when server runtime config contains a value copied from a secret build environment variable. The error lists config paths only
- Complete defaults and diagnostics applied to every named Wrangler environment
- Exact Cloudflare binding and runtime types generated during `nuxt prepare`

Persistent KV mounts are never wrapped. The expiry policy applies only to cache data.

## Setup

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-cloudflare'],

  nuxtCloudflare: {
    requiredSecrets: ['NUXT_SESSION_PASSWORD'],
  },

  nitro: {
    storage: {
      cache: { driver: 'cloudflare-kv-binding', binding: 'CACHE' },
      kv: { driver: 'cloudflare-kv-binding', binding: 'KV' },
    },
  },
})
```

To configure a cache mount when one does not already exist:

```ts
export default defineNuxtConfig({
  nuxtCloudflare: {
    kvCache: {
      binding: 'CACHE',
      defaultTtl: 30 * 24 * 60 * 60,
    },
  },
})
```

Cloudflare KV requires TTLs of at least 60 seconds. The cache wrapper raises shorter positive TTLs to 60 seconds.

Keep server runtime secret defaults empty. Nuxt reads matching `NUXT_*` values from Worker secret bindings at runtime. The production build guard rejects secret build environment values before Nitro can include them in the bundle. Nuxt Scripts proxy signing remains allowed because that module registers its security plugin during the build.

Workers Caching is separate from Nitro's KV-backed cache. The module enables version-isolated caching by default. Set `workersCache: { _tag: 'disabled' }` to opt out. Choose cross-version caching only with an explicit purge path.

Partial bundling is on by default. Wrangler's default bundling inlines every lazy chunk into one module the isolate parses at startup; on the Nuxt SEO Pro Worker that was a 26.3MB bundle, and partial bundling cut `wrangler check startup` active CPU from 118ms to 81ms by deploying chunks as separate modules. The generated config gains `find_additional_modules: true` and a fallthrough `ESModule` rule for `**/*.mjs`; rules you wrote are kept, and one that already covers mjs wins. Configs with `no_bundle` inject neither key, because Wrangler already defaults `find_additional_modules` to true there and applies your rules as written. Set `partialBundles: false` to keep single-bundle deploys.

The module writes a fail-closed `private, no-store` before routing, so a response nobody described is never cached. It never rewrites a policy you set on a response that is not a rendered document, so asset and API route rules are yours.

For a rendered document it applies `workersCache.html`:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Honour your `cache-control`, clamped to a retention window another module publishes. Falls back to `no-store` when nothing publishes one. |
| `app` | Always honour your `cache-control`. You own the version-skew risk. |
| `no-store` | Always overwrite it. |

A cached document can name build chunks a later deploy deleted, which is why `auto` needs a guarantee. [`nuxt-skew-protection`](https://github.com/harlan-zw/nuxt-skew-protection) publishes one when you set `skewProtection: { htmlCache: true }`.

Four things are refused whatever you configure, because a shared cache keys on the URL: a request carrying credentials, a response setting a cookie, a status other than 200, and a response varying on `Cookie` or `Authorization`.

### Writing cache rules

`edgeCache` builds the headers for a route rule:

```ts
import { edgeCache, NO_STORE } from '@harlan-zw/nuxt-cloudflare/cache'

export default defineNuxtConfig({
  routeRules: {
    '/api/feed': edgeCache({ maxAge: 60 }),
    '/api/reports': edgeCache({ maxAge: 3600, staleWhileRevalidate: 86400, browser: 'revalidate' }),
    '/api/private': NO_STORE,
  },
})
```

It emits `max-age`, never `s-maxage`. Cloudflare reads `s-maxage` as implying `proxy-revalidate`, which disables `stale-while-revalidate` and `stale-if-error`, so a policy that looks like it serves stale blocks on revalidation instead. The module warns at build if a route rule you wrote by hand hits that.

## Cost controls

Cloudflare pricing changes. Check the linked pricing pages before making a budget.

- Workers Logs use a 1% routine sample. Paid plans include 20 million monthly events. Extra events cost $0.60 per million. See [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing).
- Invocation logs remain enabled. High-volume Workers with complete error telemetry can set `observability.logs.invocation_logs: false`. This removes one event per sampled invocation.
- Traces use a separate 1% sample. Each span is metered. [Trace pricing](https://developers.cloudflare.com/workers/observability/traces/#limits--pricing) lists 10 million included monthly events. It also says the quota is shared with logs. The Workers Logs page lists 20 million. Budget against 10 million until the pages agree.
- Workers Caching uses version isolation by default. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers) bills cache hits as Worker requests. This includes static assets and Worker-to-Worker requests. Disable caching when CPU savings do not exceed the added request cost.
- Static assets stay asset first. Their requests are free and unlimited. The module warns when blanket Worker-first routing makes assets billable.
- Cloudflare's 30-second CPU limit remains unchanged. The doctor warns when `limits.cpu_ms` exceeds 30,000. A higher ceiling increases runaway-cost exposure.
- Queue retries add billed read operations. Each 64 KB message chunk incurs write, read, and delete operations. Keep payloads small and retries deliberate.
- The KV-backed Nitro cache expires entries after 30 days. This bounds stored cache data. It does not reduce billed operations.

[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) charges for rows read, rows written, and stored data. Indexes reduce billed scans but add writes and storage. Read replicas add no separate charge. The module preserves D1 routing and session behavior.

Doctor warnings surface log or trace sampling above 1%, Workers Caching with static assets, CPU limits above 30 seconds, and queue retries above three.

## Doctor

Audit Wrangler's effective configuration, including generated config redirects and named environments:

```sh
pnpm nuxt-cloudflare doctor
pnpm nuxt-cloudflare doctor --env production --json
pnpm nuxt-cloudflare doctor --strict --allow-warning source-maps-disabled
```

The CLI reads Wrangler config through Wrangler itself, so JSON, JSONC, TOML, environments, upward lookup, and Nitro generated-config redirects follow deployment semantics. It separately inspects root authoring format. Existing TOML remains supported and receives non-blocking guidance because Cloudflare recommends JSONC for new projects. Shadowed root configs warn because they can silently drift.

Errors cover malformed asset patterns, invalid Durable Object lifecycles, invalid Container storage, queue limits, unsafe example bindings, and unflattened generated environments. Warnings cover blanket Worker-first assets, missing environment bindings, unrestricted email, local service fidelity, deprecated fields, telemetry gaps, and public endpoints. Secret values are never included.

Normal mode fails errors. `--strict` also fails warnings. Intentional exceptions remain visible and may be listed with `--allow-warning`. Module builds use the equivalent policy:

`nodejs_compat` is required by default because this is a Nuxt module. Use `--node-compat ignore` only when auditing a non-Nuxt companion Worker, such as a redirect-only Worker.

```ts
export default defineNuxtConfig({
  nuxtCloudflare: {
    doctor: {
      _tag: 'strict',
      allowedWarnings: ['source-maps-disabled'],
    },
  },
})
```

Recommended CI sequence:

```sh
pnpm nuxt build
pnpm nuxt-cloudflare doctor --strict
pnpm wrangler types --check --config .output/server/wrangler.json
pnpm wrangler deploy --strict --dry-run --config .output/server/wrangler.json --outdir .wrangler-dist
pnpm wrangler check startup --config .output/server/wrangler.json
```

Pass the final generated config explicitly to `types` and `check startup`; Nitro's `.wrangler/deploy/config.json` redirect does not apply to those commands.

### Product guidance

- Named environments do not inherit bindings. The doctor reports each omitted root binding.
- AI, Browser, Images, mTLS, Vectorize, and Flagship warn when local development omits `remote: true`.
- Every Container must match a local SQLite Durable Object. Legacy `dev` and `standard` instance types warn.
- Email bindings should restrict senders or destinations.
- Legacy module bindings and the old Pipeline `pipeline` field warn with their current replacements.

## Runtime primitives

### D1 sessions and safe retries

```ts
import {
  getRecoveringRequestD1Session,
  retryIdempotentD1Write,
} from '@harlan-zw/nuxt-cloudflare/d1'

const session = getRecoveringRequestD1Session(
  event.context,
  'DB',
  event.context.cloudflare.env.DB,
)

await retryIdempotentD1Write({
  safety: { _tag: 'replay-safe' },
  run: () => session.prepare('INSERT OR IGNORE INTO jobs (id) VALUES (?)').bind(id).run(),
})
```

`getRecoveringRequestD1Session` caches one `first-primary` session per request and binding. Use `withD1ResetRecovery` when no request context exists. D1 already retries read-only queries. Recovery handles failures that outlive those retries. It opens a replacement session after `D1_RESET_DO`, carries the last bookmark, and rebuilds the prepared statement with its bound values. Replica disconnects and connection loss retry on the current session.

Recovery replays only `SELECT`, read-only CTE, and `EXPLAIN` statements. It never replays writes, PRAGMA statements, mixed batches, or unknown statements. A session reset still opens a healthy session for the next statement. `onRecovery` receives tagged `retrying` or `stopped` events for request telemetry.

Write retries require an explicit safety tag. `lock-only` retries SQLite lock contention; `replay-safe` also permits classified network and storage reset failures. Resource pressure, queue delay, CPU, and memory errors are never retried.

### D1 parameter plans

```ts
import {
  assertD1BoundParameters,
  chunkD1Items,
  defineD1ParameterPlan,
} from '@harlan-zw/nuxt-cloudflare/d1'

const siteIdPlan = defineD1ParameterPlan({
  parametersPerItem: 1,
  reservedParameters: 2,
})

for (const ids of chunkD1Items(siteIds, siteIdPlan)) {
  const query = db.select().from(sites).where(inArray(sites.id, ids))
  assertD1BoundParameters(query.toSQL().params)
  await query
}
```

D1 allows 100 bound parameters per statement, including each statement inside `db.batch()`. The parsed opaque plan rejects fractions, non-finite values, negative reservations, forged runtime plans, and budgets that cannot fit one item. `parametersPerItem` supports multi-row inserts; `reservedParameters` accounts for fixed binds and deliberate headroom. `assertD1BoundParameters` verifies the final ORM output in regression tests. Chunk execution, ordering, transaction boundaries, and result merging remain explicit at the call site.

### Bindings

```ts
import type { H3Event } from 'h3'
import { createCloudflareBindings, useCloudflareRuntimeConfig } from '@harlan-zw/nuxt-cloudflare/bindings'

const cloudflare = createCloudflareBindings()

function requireDatabase(source?: unknown) {
  return cloudflare.require('DB', source)
}

// `event` on the request path, nothing in a queue, scheduled, email, or task handler.
function apiToken(event?: H3Event) {
  return useCloudflareRuntimeConfig(event).apiToken
}
```

`nuxt prepare` runs Wrangler and writes exact, compatibility-aware types to `.nuxt/types/cloudflare-bindings.d.ts`. It merges root JSON, JSONC, or TOML bindings with `nitro.cloudflare.wrangler`. Nuxt and Nitro typechecks both reference the declaration, while bindings remain server runtime values. Production builds compare it with the final generated Wrangler config and fail on drift. Set `bindingTypes: false` only when another tool owns the declaration.

The source may be an H3 event, Nitro task input, or task context. Eventless access uses Nitro's `globalThis.__env__` Cloudflare entry shim. An explicit environment always wins and never mixes with the global environment. Binding names come from the generated `CloudflareBindings` interface. Missing required bindings throw. Pass a generic only to override generated types in a focused test.

`useCloudflareRuntimeConfig` reads runtime config from both contexts. On Cloudflare, `NUXT_*` Worker vars and secrets bind onto runtime config only through an event, so a bare `useRuntimeConfig()` off the request path returns build-time defaults. Without an event this reads the Cloudflare entry environment and wraps it as the source Nitro requires. The module's Nitro plugin supplies the reader; use `runtimeConfigSource` directly only when you own the `useRuntimeConfig` call.

### Scoped secrets file

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveWorkerSecrets, withWorkerSecretsFile } from '@harlan-zw/nuxt-cloudflare/deploy'

const exec = promisify(execFile)

const resolved = resolveWorkerSecrets(['API_TOKEN'], process.env)
if (resolved._tag === 'missing')
  throw new Error(`Missing Worker secrets: ${resolved.names.join(', ')}`)

await withWorkerSecretsFile({
  secrets: resolved.secrets,
  use: path => exec('pnpm', ['wrangler', 'deploy', '--secrets-file', path]),
})
```

The helper owns a private temporary directory and creates the JSON file with mode 0600. It removes the directory after deployment succeeds or fails. Secret values may be strings or `null`; Wrangler treats `null` as a deletion marker.

## Deliberate boundaries

The module does not choose Worker names, routes, domains, resource IDs, placement, CPU limits, queue jobs, R2 deletion policy, or deployment promotion. `@harlan-zw/nuxt-cf-jobs` continues to own queues, job durability, recovery, and outbox behavior.

Next high-value extractions from Nuxt SEO and gscdump:

1. Nuxt Content D1 sync plus readiness verification
2. Expand-only D1 migration audit with protected-table rebuild detection
3. Lease/CAS API idempotency with canonical request fingerprints
4. D1 request telemetry for serial waves, rows, regions, and primary versus replica reads
5. Atomic D1 fixed-window rate limiting
6. R2 lifecycle declaration and read-only storage stocktake

These remain separate adapters because their schemas, retention, and deployment ordering require explicit application policy.
