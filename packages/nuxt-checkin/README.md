# Nuxt Check-in

Run deterministic checks from your Nuxt app and its modules.
Discover definitions at build time. Execute them through a route or an external runner.

## Install

```sh
pnpm add @harlan-zw/nuxt-checkin
```

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-checkin'],
})
```

The module scans `server/checks` in the app and every Nuxt layer.
Use `checkin.dirs` to supply explicit paths relative to the app root.
Tests, declaration files, and files starting with `_` are excluded.
Each file must default-export a factory call with a literal `id`.
Duplicate IDs stop the build. Discovery never executes check files.

## Site checks

```ts
// server/checks/catalog.ts
import { defineCheck, fail, pass, warn } from '@harlan-zw/nuxt-checkin/server'
import { readCatalogAge } from '../utils/catalog'

export default defineCheck({
  id: 'catalog.freshness',
  async run({ now, signal }) {
    const hours = await readCatalogAge({ now, signal })
    if (hours >= 24)
      return fail('Catalog is over 24 hours old.', { hours })
    if (hours >= 6)
      return warn('Catalog is over 6 hours old.', { hours })
    return pass({ hours })
  },
})
```

Checks receive `event`, `now`, `signal`, and named `credentials`.
Use `defineCheck<Event>()` when a custom check needs a typed request event.
The runner supplies one observation time to every check.
Keep domain evaluation pure when several callers need the same decision.

## Route

```ts
import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import checks from '#checkin/checks'
import { requireAdmin } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return runChecks(checks, { event, concurrency: 4, timeoutMs: 10_000 })
})
```

No route is installed automatically. The consuming app owns authentication.
The virtual module uses static imports and remains server-only.
Importing it loads definitions. Only `runChecks` performs the reads.
The registry refreshes when watched check files change during development.

## Results

| Result | Meaning |
| --- | --- |
| `pass(evidence)` | The check established its expected condition. |
| `warn(reason, evidence)` | The warning threshold was met. |
| `fail(reason, evidence)` | The failure threshold was met. |
| `unavailable(reason)` | Evidence could not establish health. |
| `skipped(reason)` | An explicit applicability decision prevented execution. |

The report contains `observedAt`, `severity`, `coverage`, and ordered `results`.
Each result includes its ID and duration.
A failure stays visible even when another check has unavailable evidence.
An empty registry has incomplete coverage.
Never interpret `severity: pass` without checking `coverage`.

Thrown exceptions become `Unavailable`. Raw exceptions stay out of the returned report.
Use `onError(error, id)` to record them privately. Exceptions in that callback propagate.
Evidence must contain JSON values. Check authors own evidence redaction.
Pass an AbortSignal to cancel a run. Checks must cooperate with cancellation for underlying work to stop.
Do not use checks to perform repairs, deploy, send messages, or change Sentry state.

## Existing modules

Each integration registers the same public factory that a site can import.
Registration is explicit. It does not add default production queries to existing installations.

```ts
export default defineNuxtConfig({
  modules: [
    '@harlan-zw/nuxt-checkin',
    '@harlan-zw/nuxt-cloudflare',
    '@harlan-zw/nuxt-cf-jobs',
    '@harlan-zw/nuxt-sentry',
  ],
  nuxtCloudflare: {
    checks: [{ id: 'd1.read', binding: 'DB' }],
  },
  cfJobs: {
    queues: { indexing: 'INDEXING_QUEUE' },
    checks: [{
      id: 'queue.indexing',
      queue: 'indexing',
      d1Binding: 'DB',
      warnAfterSeconds: 1800,
      failAfterSeconds: 7200,
      staleAfterSeconds: 900,
    }],
  },
  nuxtSentry: {
    dsn: 'https://public@example.com/1',
    project: 'site',
    checks: [{ id: 'sentry.site', org: 'example', project: 'site' }],
  },
})
```

Sentry checks need `id`, `org`, and `project`; optional `credential` defaults to `sentry`.
Supply the read token through `runChecks(checks, { credentials: { sentry: token } })`.
Never put tokens in Nuxt module options. Options enter the generated registry.

The D1 factory proves a read through the request's binding.
The queue factory uses existing Queue Job backpressure SQL and excludes future scheduled work.
It expects the module's standard D1 tables. Missing or incompatible tables produce unavailable evidence.
The Sentry factory reads unresolved issues active in the last 14 days and follows pagination.
It warns on unresolved issues. It does not infer user impact or investigate stacks.
The default ten-page limit produces incomplete coverage when exceeded.
This check does not replace a complete historical Sentry backlog audit.

Direct usage has the same behavior:

```ts
// server/checks/queue.ts
import { defineQueueCheck } from '@harlan-zw/nuxt-cf-jobs/checks'

export default defineQueueCheck({
  id: 'queue.indexing',
  queue: 'indexing',
  d1Binding: 'DB',
  warnAfterSeconds: 1800,
  failAfterSeconds: 7200,
})
```

Choose module registration or a site file for each ID. Registering both fails the build.

## Module authors

```ts
nuxt.hook('checkin:register', (registry) => {
  registry.add({
    id: 'catalog.freshness',
    handler: resolver.resolve('./checks'),
    options: { warnAfterSeconds: 3600 },
  })
})
```

The handler default-exports a public factory accepting `{ id, ...options }` and returning a Check.
Handlers use absolute paths. Options must be JSON values.
Contributions are collected after module setup, so registration does not depend on module order.
Installing a contributing module without Nuxt Check-in leaves this integration inactive.

## Runtime limits

Cloudflare request bindings belong in authenticated route checks.
GitHub, provider administration, and broad Sentry credentials belong in an external runner where possible.
External callers import public factories and call `runChecks` directly; they do not need the virtual registry.
The core runtime imports no Nuxt, Node, or provider SDK code.
