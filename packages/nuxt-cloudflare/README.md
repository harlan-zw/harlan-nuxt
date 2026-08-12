# @harlan-zw/nuxt-cloudflare

Opinionated Cloudflare defaults and deploy diagnostics for Nuxt 4.

The module extracts production patterns already proven in Nuxt SEO and gscdump. It intentionally owns platform policy, not application topology.

## Defaults

- Cloudflare module preset, generated Wrangler config, and Node compatibility
- Static assets remain asset first by default. Blanket `assets.run_worker_first: true` warns because valid authentication and transform use cases exist
- Workers Logs sampled at 10%, traces at 1%, both overridable
- Preview URLs disabled unless explicitly enabled
- `workers_dev` disabled when a route proves the Worker remains reachable; workers without routes must choose explicitly
- Version metadata binding at `CF_VERSION_METADATA`
- Smart Placement enabled unless the project chooses a placement
- Workers Caching enabled with version isolation
- Rendered HTML forced to `private, no-store`; explicit non-HTML cache policies remain intact
- Source-map upload when the Nitro build emits maps; explicit `false` is preserved
- Module-wide `secrets.required` names copied to each environment; source root secrets remain scoped to the root
- Version metadata is skipped when `CF_VERSION_METADATA` already names another binding
- Raw `cloudflare-kv-binding` on Nitro's `cache` mount upgraded to a 30-day physical expiry
- Final generated Wrangler config validated through Wrangler, then audited after production Nitro compiles
- Production builds fail when server runtime config contains a value copied from a secret build environment variable. The error lists config paths only
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

Cloudflare KV requires TTLs of at least 60 seconds. The cache wrapper raises shorter positive TTLs to 60 seconds.

Keep server runtime secret defaults empty. Nuxt reads matching `NUXT_*` values from Worker secret bindings at runtime. The production build guard rejects secret build environment values before Nitro can include them in the bundle. Nuxt Scripts proxy signing remains allowed because that module registers its security plugin during the build.

Workers Caching is separate from Nitro's KV-backed cache. The module enables version-isolated caching by default. Rendered HTML always stays private. API and asset responses keep explicit cache policies. Set `workersCache: { _tag: 'disabled' }` to opt out. Choose cross-version caching only with an explicit purge path.

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

The module does not choose Worker names, routes, domains, resource IDs, placement, CPU limits, queue jobs, R2 deletion policy, or deployment promotion. `@harlan-zw/nuxt-cf-jobs` continues to own queues, job durability, recovery, and outbox behavior.

Next high-value extractions from Nuxt SEO and gscdump:

1. Nuxt Content D1 sync plus readiness verification
2. Expand-only D1 migration audit with protected-table rebuild detection
3. Lease/CAS API idempotency with canonical request fingerprints
4. D1 request telemetry for serial waves, rows, regions, and primary versus replica reads
5. Atomic D1 fixed-window rate limiting
6. R2 lifecycle declaration and read-only storage stocktake

These remain separate adapters because their schemas, retention, and deployment ordering require explicit application policy.
