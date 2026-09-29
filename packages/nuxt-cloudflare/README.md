<h1>@harlan-zw/nuxt-cloudflare</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Cloudflare gives a Nuxt 4 app Cloudflare defaults, a generated Wrangler config, and Wrangler diagnostics. A bad deploy fails in your build before Cloudflare rejects it.

The defaults come from production patterns already running in Nuxt SEO and gscdump. The module owns platform policy. Your application topology stays yours.

<p align="center">
<table>
<tbody>
<td align="center">
<sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br> Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub><br>
</td>
</tbody>
</table>
</p>

## Features

- ⚙️ **Generated Wrangler config:** you skip the Cloudflare boilerplate, and every key you wrote stays yours.
- 🩺 **Deploy doctor:** a broken Wrangler config fails in CI, before a deploy reaches Cloudflare.
- 💰 **Cost controls:** surprise bills from unsampled logs or newly billable asset requests get flagged before you deploy.
- 🗄️ **Workers Caching:** one deploy never serves another deploy's cache, and rendered pages stay out of the shared cache by default.
- 📦 **Partial bundling:** large Workers start faster; the Nuxt SEO Pro Worker dropped from 118ms to 81ms startup CPU.
- 🔑 **Exact binding types:** a wrong binding name or stale binding type fails before it reaches production.
- 🧰 **D1 primitives:** session resets, lock contention, and the 100-bind limit stop breaking your queries.

## Installation

```bash
npx nuxi@latest module add @harlan-zw/nuxt-cloudflare
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-cloudflare
> ```

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

## Defaults

Every default below yields to a value you wrote. The root `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` is authored config, and so is `nitro.cloudflare.wrangler`. A module default applies only where neither names the key. Workers Caching is the one exception: the module owns that policy because it also registers the caching plugin.

- Cloudflare module preset, generated Wrangler config, and Node compatibility
- Static assets remain asset first by default. Blanket `assets.run_worker_first: true` warns because valid authentication and transform use cases exist
- Workers Logs sampled at 1%, traces at 1%, both overridable
- Preview URLs disabled unless you enable them
- `workers_dev` disabled when a route keeps the Worker reachable; a Worker without routes must set it
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

## Configuration

Everything below is optional. The defaults cover a plain deploy.

If you have no cache mount, configure one:

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

Keep server runtime secret defaults empty. At runtime, Nuxt reads matching `NUXT_*` values from Worker secret bindings. The production build guard rejects a secret build environment value before Nitro can put it in the bundle. Nuxt Scripts proxy signing still works, because that module registers its security plugin during the build.

Workers Caching is separate from Nitro's KV-backed cache. The module turns on version-isolated caching by default. To opt out, set `workersCache: { _tag: 'disabled' }`. Choose cross-version caching only if you have a purge path.

Partial bundling is on by default. Wrangler's default bundling inlines every lazy chunk into one module, and the isolate parses all of it at startup. On the Nuxt SEO Pro Worker that module was 26.3MB. Deploying chunks as separate modules cut `wrangler check startup` active CPU from 118ms to 81ms.

The generated config gains `find_additional_modules: true` and a fallthrough `ESModule` rule for `**/*.mjs`. The module keeps rules you wrote, and a rule of yours that covers mjs wins. With `no_bundle`, the module adds neither key: Wrangler already defaults `find_additional_modules` to true there and applies your rules as written. To keep single-bundle deploys, set `partialBundles: false`.

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

It emits `max-age`, never `s-maxage`. Cloudflare reads `s-maxage` as `proxy-revalidate`, which turns off `stale-while-revalidate` and `stale-if-error`. A policy that looks like it serves stale then blocks on revalidation. If a route rule you wrote by hand hits this, the module warns at build.

## Cost controls

Cloudflare pricing changes. Before you set a budget, check the linked pricing pages.

- Workers Logs use a 1% routine sample. Paid plans include 20 million monthly events. Extra events cost $0.60 per million. See [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing).
- Invocation logs stay on. If a high-volume Worker already has full error telemetry, set `observability.logs.invocation_logs: false`. This removes one event per sampled invocation.
- Traces use a separate 1% sample. Each span is metered. [Trace pricing](https://developers.cloudflare.com/workers/observability/traces/#limits--pricing) lists 10 million included monthly events. It also says the quota is shared with logs. The Workers Logs page lists 20 million. Budget against 10 million until the pages agree.
- Workers Caching uses version isolation by default. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers) bills cache hits as Worker requests. This includes static assets and Worker-to-Worker requests. Disable caching when CPU savings do not exceed the added request cost.
- Static assets stay asset first. Their requests are free and unlimited. The module warns when blanket Worker-first routing makes assets billable.
- Cloudflare's 30-second CPU limit remains unchanged. The doctor warns when `limits.cpu_ms` exceeds 30,000. A higher ceiling increases runaway-cost exposure.
- Queue retries add billed read operations. Each 64 KB message chunk costs a write, a read, and a delete. Keep payloads small and retries few.
- The KV-backed Nitro cache expires entries after 30 days. This bounds stored cache data. It does not reduce billed operations.

[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) charges for rows read, rows written, and stored data. Indexes reduce billed scans but add writes and storage. Read replicas cost nothing extra. The module does not change D1 routing or session behavior.

The doctor warns on log or trace sampling above 1%, Workers Caching with static assets, CPU limits above 30 seconds, and queue retries above three.

## Doctor

Audit the config Wrangler will actually deploy, including generated config redirects and named environments:

```sh
pnpm nuxt-cloudflare doctor
pnpm nuxt-cloudflare doctor --env production --json
pnpm nuxt-cloudflare doctor --strict --allow-warning source-maps-disabled
```

The CLI reads Wrangler config through Wrangler itself. JSON, JSONC, TOML, environments, upward lookup, and Nitro generated-config redirects resolve the same way a deploy resolves them. The CLI also checks the format of the root config. TOML still works; the doctor suggests JSONC without failing, because Cloudflare recommends JSONC for new projects. A shadowed root config warns, because it can drift without anyone noticing.

Errors cover `_headers` and `_redirects` files past Cloudflare's rule limits, malformed asset patterns, invalid Durable Object lifecycles, invalid Container storage, queue limits, unsafe example bindings, and unflattened generated environments.

Warnings cover blanket Worker-first assets, missing environment bindings, unrestricted email, local service fidelity, deprecated fields, telemetry gaps, and public endpoints. The output never includes secret values.

`nodejs_compat` is required by default because this is a Nuxt module. Use `--node-compat ignore` only to audit a non-Nuxt companion Worker, such as a redirect-only Worker.

Normal mode fails on errors. `--strict` also fails on warnings. An intentional exception stays visible; list it with `--allow-warning`. Module builds use the same policy:

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

Pass the final generated config to `types` and `check startup` yourself. Nitro's `.wrangler/deploy/config.json` redirect does not apply to those commands.

### Product guidance

- Named environments do not inherit bindings. The doctor reports each omitted root binding.
- AI, Browser, Images, mTLS, Vectorize, and Flagship warn when local development omits `remote: true`.
- Every Container must match a local SQLite Durable Object. Legacy `dev` and `standard` instance types warn.
- An email binding without a sender or destination restriction warns.
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

`getRecoveringRequestD1Session` caches one `first-primary` session per request and binding. If no request context exists, use `withD1ResetRecovery`. D1 already retries read-only queries. Recovery handles the failures that outlast those retries. It opens a replacement session after `D1_RESET_DO`, carries the last bookmark, and rebuilds the prepared statement with its bound values. Replica disconnects and connection loss retry on the current session.

Recovery replays only `SELECT`, read-only CTE, and `EXPLAIN` statements. It never replays writes, PRAGMA statements, mixed batches, or unknown statements. After a reset, the next statement still gets a healthy session. `onRecovery` receives tagged `retrying` or `stopped` events for request telemetry.

Every write retry needs a safety tag. `lock-only` retries SQLite lock contention; `replay-safe` also permits classified network and storage reset failures. Resource pressure, queue delay, CPU, and memory errors are never retried.

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

D1 allows 100 bound parameters per statement, including each statement inside `db.batch()`. `defineD1ParameterPlan` rejects fractions, non-finite values, negative reservations, forged runtime plans, and budgets that cannot fit one item. `parametersPerItem` supports multi-row inserts; `reservedParameters` accounts for fixed binds and deliberate headroom. `assertD1BoundParameters` checks the final ORM output in regression tests. You still write chunk execution, ordering, transaction boundaries, and result merging at the call site.

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

`nuxt prepare` runs Wrangler and writes exact, compatibility-aware types to `.nuxt/types/cloudflare-bindings.d.ts`. It merges root JSON, JSONC, or TOML bindings with `nitro.cloudflare.wrangler`. Nuxt and Nitro typechecks both use the declaration. Bindings are still server runtime values only. Production builds compare it with the final generated Wrangler config and fail on drift. If another tool owns the declaration, set `bindingTypes: false`.

Binding types use a shared cache under `$XDG_CACHE_HOME/nuxt-cloudflare` or `~/.cache/nuxt-cloudflare`. The cache key includes the Wrangler config and version. Each worktree still gets its own `.nuxt` files. To move the cache, set `cacheDir` to a shared absolute path. To skip the cache, set it to `false`.

```ts
export default defineNuxtConfig({
  nuxtCloudflare: {
    bindingTypes: {
      cacheDir: '/shared/nuxt-cloudflare',
    },
  },
})
```

The source may be an H3 event, Nitro task input, or task context. Eventless access uses Nitro's `globalThis.__env__` Cloudflare entry shim. An explicit environment always wins and never mixes with the global environment. Binding names come from the generated `CloudflareBindings` interface. A missing required binding throws. Pass a generic only to override generated types in a focused test.

`useCloudflareRuntimeConfig` reads runtime config from both contexts. On Cloudflare, `NUXT_*` Worker vars and secrets bind onto runtime config only through an event, so a bare `useRuntimeConfig()` off the request path returns build-time defaults. Without an event, it reads the Cloudflare entry environment and wraps it as the source Nitro needs. The module's Nitro plugin supplies the reader; use `runtimeConfigSource` directly only when you own the `useRuntimeConfig` call.

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

The helper creates a private temporary directory and writes the JSON file with mode 0600. It removes the directory whether the deploy succeeds or fails. Secret values may be strings or `null`; Wrangler treats `null` as a deletion marker.

## Deliberate boundaries

The module does not choose Worker names, routes, domains, resource IDs, placement, CPU limits, queue jobs, R2 deletion policy, or deployment promotion. `@harlan-zw/nuxt-cf-jobs` owns queues, job durability, recovery, and outbox behavior.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-cloudflare/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-cloudflare/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-cloudflare

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-cloudflare.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-cloudflare

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-cloudflare/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
