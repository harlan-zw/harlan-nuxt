# @harlan-zw/nuxt-cloudflare

Opinionated Cloudflare defaults and deploy diagnostics for Nuxt 4.

The module extracts production patterns already proven in Nuxt SEO and gscdump. It intentionally owns platform policy, not application topology.

## Defaults

- Cloudflare module preset, generated Wrangler config, and Node compatibility
- Static assets always bypass the Worker. Any `assets.run_worker_first` declaration fails the build and `doctor`
- Workers Logs sampled at 10%, traces at 1%, both overridable
- Version metadata binding at `CF_VERSION_METADATA`
- Source-map upload when the Nitro build emits maps; explicit `false` is preserved
- `secrets.required` names only, with plaintext secret-looking `vars` rejected
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

## Doctor

Audit Wrangler's effective configuration, including generated config redirects and named environments:

```sh
pnpm nuxt-cloudflare doctor
pnpm nuxt-cloudflare doctor --env production --json
```

Errors include worker-first assets, missing `nodejs_compat`, malformed compatibility dates, and secret-looking plaintext variables. Diagnostics report secret names only.

Recommended CI sequence:

```sh
pnpm nuxt build
pnpm nuxt-cloudflare doctor
pnpm wrangler types --check
pnpm wrangler deploy --strict --dry-run --outdir .wrangler-dist
pnpm wrangler check startup
```

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
