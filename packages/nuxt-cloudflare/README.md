# @harlan-zw/nuxt-cloudflare

Opinionated Cloudflare defaults and deploy diagnostics for Nuxt 4.

The module extracts production patterns already proven in Nuxt SEO and gscdump. It intentionally owns platform policy, not application topology.

## Defaults

- Cloudflare module preset, generated Wrangler config, and Node compatibility
- Static assets remain asset first by default. Blanket `assets.run_worker_first: true` fails the build and `doctor`; narrow route-pattern arrays remain available for intentional middleware and skew recovery
- Workers Logs sampled at 10%, traces at 1%, both overridable
- Preview URLs disabled unless explicitly enabled
- `workers_dev` disabled when a route proves the Worker remains reachable; workers without routes must choose explicitly
- Version metadata binding at `CF_VERSION_METADATA`
- Workers Caching enabled by default with per-version isolation
- Dynamic responses default to `private, no-store`; rendered HTML is forcibly private and conflicting route rules are diagnosed
- Smart Placement enabled by default; explicit region, host, or hostname placement is preserved
- Source-map upload when the Nitro build emits maps; explicit `false` is preserved
- Module-wide `secrets.required` names copied to each environment; source root secrets remain scoped to the root
- Version metadata is skipped when `CF_VERSION_METADATA` already names another binding
- Raw `cloudflare-kv-binding` on Nitro's `cache` mount upgraded to a 30-day physical expiry
- Final generated Wrangler config audited after production Nitro compiles
- Complete defaults and diagnostics applied to every named Wrangler environment

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

Cloudflare KV requires TTLs of at least 60 seconds.

Workers Caching is separate from Nitro's KV-backed cache. It is enabled by default with `cross_version_cache: false`, so each deployment starts with an isolated cache. Dynamic Nitro responses default to `Cache-Control: private, no-store` and `Cloudflare-CDN-Cache-Control: no-store` unless they declare an explicit cache policy. Rendered HTML always receives those private directives; this is required because Cloudflare otherwise heuristically caches a `200` response with no cache header for two hours.

Potential HTML route rules warn when they use `cache`, `isr`, `swr`, or publicly cacheable `Cache-Control`, `CDN-Cache-Control`, and `Cloudflare-CDN-Cache-Control` headers. Rules proven to be HTML through prerendering, a `.html` path, or an explicit `text/html` content type fail the build. Explicit `private` and `no-store` policies are safe. API, Nuxt OG Image, and static asset routes remain available for explicit caching. Disable Workers Caching only for a gateway that must execute on every request:

```ts
export default defineNuxtConfig({
  nuxtCloudflare: {
    workersCache: { _tag: 'disabled' },
  },
})
```

Smart Placement moves fetch handlers only when Cloudflare measures a faster location near upstream services. Assets-first delivery remains close to the user. Queue handlers, RPC methods, and named entrypoints are unaffected. An authored region, host, or hostname placement overrides the smart default.

## Doctor

Audit Wrangler's effective configuration, including generated config redirects and named environments:

```sh
pnpm nuxt-cloudflare doctor
pnpm nuxt-cloudflare doctor --env production --json
pnpm nuxt-cloudflare doctor --strict --allow-warning source-maps-disabled
```

The CLI reads Wrangler config through Wrangler itself, so JSON, JSONC, TOML, environments, upward lookup, and Nitro generated-config redirects follow deployment semantics. It separately inspects root authoring format. Existing TOML remains supported and receives non-blocking guidance because Cloudflare recommends JSONC for new projects. Shadowed root configs warn because they can silently drift.

Errors cover blanket Worker-first assets, malformed selective asset patterns, missing `nodejs_compat`, malformed compatibility dates, secret names duplicated across `vars` and `secrets.required`, queue platform-limit violations, and unflattened generated environments. Warnings cover secret-looking variable names, telemetry gaps, stale dates, implicit or cross-version Workers Caching, `keep_vars`, public endpoints, preview URLs, missing DLQs, and project policy. Secret values are never included.

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

## Runtime primitives

### D1 sessions and safe retries

```ts
import { getRequestD1Session, retryIdempotentD1Write } from '@harlan-zw/nuxt-cloudflare/d1'

const session = getRequestD1Session(event.context, 'DB', event.context.cloudflare.env.DB)

await retryIdempotentD1Write({
  safety: { _tag: 'replay-safe' },
  run: () => session.prepare('INSERT OR IGNORE INTO jobs (id) VALUES (?)').bind(id).run(),
})
```

One `first-primary` session is cached per request and binding. D1 already retries read-only queries. Write retries require an explicit safety tag. `lock-only` retries SQLite lock contention; `replay-safe` also permits classified transient network and reset failures.

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
import type { CloudflareEventLike } from '@harlan-zw/nuxt-cloudflare/bindings'
import { requireCloudflareBinding } from '@harlan-zw/nuxt-cloudflare/bindings'

function requireDatabase(event: CloudflareEventLike<Env>) {
  return requireCloudflareBinding(event, 'DB')
}
```

`Env` comes from `wrangler types`. Binding access is request-bound and binding names are constrained to `keyof Env`. Missing required bindings throw; there is no global or empty-object fallback.

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
  path: '/secure/temp/secrets.json',
  secrets: resolved.secrets,
  use: path => exec('pnpm', ['wrangler', 'deploy', '--secrets-file', path]),
})
```

The writer uses exclusive creation and mode 0600. It removes partial files after write failures and removes the completed file after deployment succeeds or fails.

## Deliberate boundaries

The module does not choose Worker names, routes, domains, resource IDs, CPU limits, queue jobs, R2 deletion policy, or deployment promotion. `@harlan-zw/nuxt-cf-jobs` continues to own queues, job durability, recovery, and outbox behavior.

Next high-value extractions from Nuxt SEO and gscdump:

1. Nuxt Content D1 sync plus readiness verification
2. Expand-only D1 migration audit with protected-table rebuild detection
3. Lease/CAS API idempotency with canonical request fingerprints
4. D1 request telemetry for serial waves, rows, regions, and primary versus replica reads
5. Atomic D1 fixed-window rate limiting
6. R2 lifecycle declaration and read-only storage stocktake

These remain separate adapters because their schemas, retention, and deployment ordering require explicit application policy.
