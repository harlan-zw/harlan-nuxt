<h1>@harlan-zw/nuxt-use-query</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Use Query brings TanStack-shaped composables to Nuxt's own data layer, so caching, SWR, and invalidation run through the payload rather than alongside it.

Status: experimental. APIs may change before the first scoped release.

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

- 🔄 **Queries and mutations:** `useNuxtQuery` wraps Nuxt `useFetch` with stale-time revalidation, polling, and enabled gates; `useNuxtMutation` adds invalidation and optimistic rollback.
- 📇 **Typed RPC contracts:** `defineNuxtRpcQuery`, `defineNuxtRpcMutation`, `useNuxtRpcQuery`, and `useNuxtRpc` centralize Client -> API contracts in query folders with [Zod](https://zod.dev) request/response schemas.
- 🗝️ **Cache control:** `invalidateNuxtQueries`, `getQueryData`, and `setQueryData` work with Nuxt payload and live `_asyncData` state.
- ⚡ **Realtime bridge:** `useNuxtSubscription` pipes a WebSocket, SSE, or vendor SDK stream into the cache, with an optional `nuxtWebSocketSource` adapter built on [VueUse](https://vueuse.org).
- 🧵 **SSR-safe by construction:** cache bookkeeping lives on the Nuxt app instance for per-request isolation.

## Installation

Install `@harlan-zw/nuxt-use-query` in the consuming Nuxt site:

```bash
npx nuxi@latest module add @harlan-zw/nuxt-use-query
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-use-query
> ```

If the site will define RPC contracts, add Zod as a direct app dependency:

```bash
pnpm add zod
```

Or install it manually:

```bash
pnpm add @harlan-zw/nuxt-use-query zod
```

Add the module to `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-use-query'],
})
```

The module auto-imports:

- `useNuxtQuery`
- `useNuxtAsyncQuery`
- `useNuxtMutation`
- `useNuxtRpc`
- `useNuxtRpcQuery`
- `useNuxtSubscription`
- `nuxtWebSocketSource`
- `defineNuxtQueryGroup`
- `defineNuxtRpcQuery`
- `defineNuxtRpcMutation`
- `defineNuxtRpcSchemaGroup`
- `serializeNuxtRpcKey`
- `useQueryCache`
- `invalidateNuxtQueries`
- `invalidateNuxtRpc`
- `removeNuxtQueries`
- `getQueryData`
- `setQueryData`

You can also import from subpaths when using the helpers outside Nuxt's auto-import scan:

```ts
import { useNuxtMutation } from '@harlan-zw/nuxt-use-query/mutation'
import { useNuxtQuery } from '@harlan-zw/nuxt-use-query/query'
import { getQueryData, invalidateNuxtQueries, setQueryData } from '@harlan-zw/nuxt-use-query/query-cache'
import {
  defineNuxtRpcQuery,
  defineNuxtRpcSchemaGroup,
  toHumanNuxtRpcError,
  useNuxtRpcQuery,
} from '@harlan-zw/nuxt-use-query/rpc'
```

## Choosing a layer

This module ships two layers that share one cache. Pick by the contract you have:

| Use this                                       | When                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **RPC layer** (`defineNuxtRpc*` + `useNuxtRpcQuery` / `useNuxtRpc().execute`) | You own both sides of the call. Default for anything user-facing or imported in more than one place.                                       |
| **Query layer** (`useNuxtQuery` / `useNuxtMutation` directly) | Escape hatch: third-party APIs you don't own, one-off internal calls, prototypes, file downloads / blobs where a Zod schema would be theatre. |

The RPC composables wrap `useNuxtQuery`, so both layers live in the same cache and respond to the same `invalidateNuxtQueries(prefix)` calls. You can mix them in one app.

**Why the RPC default**: the operation object owns the API path, cache key, method, and Zod request/response schemas. Components import the operation, not the URL. Renaming an endpoint is a one-line change; the schema catches contract drift at the boundary instead of letting it propagate as `unknown` through the app.

**Why the escape hatch exists**: writing a contract for a fetch you call once is overhead with no payoff. Reach for `useNuxtQuery` directly when there is no second caller to protect.

**Mutations stay manual.** There is no `useNuxtRpcMutation` composable; `useNuxtMutation` plus `rpc.execute(operation, body)` is the recommended pattern (see [Execute Mutations](#4-execute-mutations) below). The thing worth writing by hand is the `invalidates` list, since a mutation operation does not know which read queries it should refresh; an auto-wrapper would hide exactly the decision you should make explicitly.

## Query defaults

`useNuxtQuery` follows TanStack Query's important defaults where Nuxt primitives allow it:

- `staleTime` defaults to `0`, so cached data is stale immediately and can refetch on mount, focus, or reconnect.
- `gcTime` defaults to 5 minutes for inactive payload eviction.
- `refetchOnMount`, `refetchOnWindowFocus`, and `refetchOnReconnect` default to `true`; pass `'always'` to bypass the stale check.
- `staleTime: Infinity` and `staleTime: 'static'` opt into immutable data until explicit invalidation.
- `isPlaceholderData`, `isPending`, and `isFetching` are exposed alongside the Nuxt `status` ref.

## Recommended site pattern

For app code, prefer the RPC helpers over hardcoded API URLs in components:

1. Put Zod request/response schemas in `shared/contracts`.
2. Put query and mutation operation factories in `app/queries`.
3. Import operations into pages, components, and composables.
4. Use stable keys that share prefixes for invalidation.

Suggested structure:

```txt
shared/
  contracts/
    sites.ts
app/
  queries/
    sites.ts
pages/
  sites/
    [siteId].vue
```

### 1. Define Shared Contracts

```ts
// shared/contracts/sites.ts
import { z } from 'zod'

export const siteSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
})

export const sitePatchSchema = z.object({
  name: z.string().nullable(),
}).strict()

export type Site = z.output<typeof siteSchema>
```

Use the same schemas in server routes and client query operations so request and response contracts stay aligned.

### 2. Define Query Operations

Define API operations beside the feature that owns them, and import shared Zod schemas from a contracts folder. Components should consume operations, not hardcoded URLs.

```ts
// app/queries/sites.ts
import {
  sitePatchSchema,
  siteSchema,
} from '~~/shared/contracts/sites'

export const siteQueries = defineNuxtQueryGroup('sites', {
  detail: (siteId: string) => defineNuxtRpcQuery({
    key: ['sites', siteId],
    path: `/api/sites/${siteId}`,
    response: siteSchema,
  }),
  update: (siteId: string) => defineNuxtRpcMutation({
    body: sitePatchSchema,
    method: 'PATCH',
    path: `/api/sites/${siteId}`,
    response: siteSchema,
  }),
})
```

Keep the operation object as the single owner of the API path, cache key, method, body schema, and response schema.

#### Defer Large Schema Groups

Load a schema group when its Zod code adds too much to the first client chunk:

```ts
const siteSchemas = defineNuxtRpcSchemaGroup(
  () => import('~~/shared/contracts/sites'),
)

export const siteQueries = defineNuxtQueryGroup('sites', {
  detail: (siteId: string) => defineNuxtRpcQuery({
    key: ['sites', siteId],
    path: `/api/sites/${siteId}`,
    response: siteSchemas('siteSchema'),
  }),
  update: (siteId: string) => defineNuxtRpcMutation({
    body: siteSchemas('sitePatchSchema'),
    method: 'PATCH',
    path: `/api/sites/${siteId}`,
    response: siteSchemas('siteSchema'),
  }),
})
```

The module loads once. Every selected schema keeps exact input and output types.

Parsing always waits for the schema group. A load failure returns a retryable `schema-load` RPC error.

Cached POST query bodies stay eager. Their parsed value forms the synchronous cache key.

### 3. Use Queries In Components

```vue
<script setup lang="ts">
import { siteQueries } from '~/queries/sites'

const route = useRoute()
const siteId = computed(() => String(route.params.siteId))

const siteQuery = useNuxtRpcQuery(
  () => siteQueries.detail(siteId.value),
  {
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  },
)
</script>

<template>
  <div v-if="siteQuery.isPending.value">
    Loading...
  </div>
  <div v-else-if="siteQuery.error.value">
    Failed to load site.
  </div>
  <h1 v-else>
    {{ siteQuery.displayData.value?.name || 'Untitled site' }}
  </h1>
</template>
```

`useNuxtRpcQuery` wraps `useNuxtQuery`, so it accepts the same cache and refetch options while validating the response with the operation's Zod schema. Both layers share one cache: an `invalidateNuxtQueries(prefix)` triggered from an RPC mutation will refresh any plain `useNuxtQuery` reads under the same prefix and vice versa.

### 4. Execute Mutations

```ts
import { siteQueries } from '~/queries/sites'

const rpc = useNuxtRpc()

async function saveSite(name: string | null) {
  await rpc.execute(siteQueries.update(siteId.value), { name })
  invalidateNuxtQueries(`sites:${siteId.value}`)
}
```

Use `useNuxtMutation` when the view needs pending/error state, lifecycle hooks, or optimistic cache writes:

```ts
import type { Site } from '~~/shared/contracts/sites'
import { siteQueries } from '~/queries/sites'

const rpc = useNuxtRpc()

const updateSite = useNuxtMutation<
  { name: string | null },
  Site,
  { previous?: Site }
>({
  mutation: body => rpc.execute(siteQueries.update(siteId.value), body),
  invalidates: () => [`sites:${siteId.value}`],
  onMutate(body) {
    const key = `sites:${siteId.value}`
    const previous = setQueryData<Site>(key, current => ({
      ...current!,
      name: body.name,
    }))
    return { previous }
  },
  onError(_error, _body, context) {
    if (context?.previous)
      setQueryData(`sites:${siteId.value}`, context.previous)
  },
})

await updateSite.mutate({ name: 'Docs' })
```

## Escape hatch: `useNuxtQuery` directly

Skip the RPC layer when the contract isn't yours to define: third-party APIs, one-off internal calls, prototypes, file downloads, or any request where a Zod schema would be ceremony with no payoff:

```ts
const search = ref('')

const { displayData, error, isFetching, refresh } = useNuxtQuery('/api/sites', {
  key: () => `sites:list:${search.value}`,
  query: { search },
  enabled: () => search.value.length >= 2,
  staleTime: 30_000,
  keepPreviousData: true,
})
```

`useNuxtQuery` passes through Nuxt `useFetch` options, and adds:

- `key`: required stable cache key.
- `enabled`: disables the initial request and later refreshes until true.
- `staleTime`: time in milliseconds before cached data is stale. Use `Infinity` or `'static'` for immutable data.
- `gcTime`: time before inactive payload data is evicted. Defaults to 5 minutes.
- `keepPreviousData`: exposes previous data through `displayData` while a new key loads. Defaults to true.
- `refetchInterval`: polling interval in milliseconds.
- `refetchOnMount`, `refetchOnWindowFocus`, and `refetchOnReconnect`: pass `true`, `false`, or `'always'`.

Reads from `useNuxtQuery` live in the same cache as RPC queries, so an `invalidateNuxtQueries('sites:')` call from either layer refreshes both.

### Server Deadline

Set a server deadline for data that should not delay the whole render:

```ts
const siteQuery = useNuxtRpcQuery(siteQueries.detail(siteId), {
  server: { deadline: 800 },
})
```

After 800ms, SSR renders the pending state. Hydration starts the query again in the browser.

`isPending` stays true. Query telemetry reports `status: 'deferred'` and `reason: 'ssr-deadline'`.

The same option works with `useNuxtQuery` and `useNuxtAsyncQuery`.

## Cache keys and invalidation

RPC array keys are serialized with `:` separators:

```ts
serializeNuxtRpcKey(['sites', siteId]) // "sites:abc"
```

Use shared prefixes so mutations can invalidate related reads:

```ts
invalidateNuxtQueries('sites:')
invalidateNuxtQueries(`sites:${siteId}`)
invalidateNuxtQueries(key => key.startsWith('sites:') && key.includes(':summary'))
```

Use cache helpers for optimistic UI:

```ts
const previous = getQueryData<Site>(`sites:${siteId}`)

setQueryData<Site>(`sites:${siteId}`, current => ({
  ...current!,
  name: 'Draft name',
}))

// Roll back if the mutation fails.
if (previous)
  setQueryData(`sites:${siteId}`, previous)
```

## Realtime: `useNuxtSubscription`

`useNuxtSubscription` bridges a realtime message stream into the cache. It does **not** own a connection: you inject the transport through `source`, and each message turns into explicit cache operations. The connection (auth, channels, reconnect) stays in whatever already owns it: a [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) module, a vendor SDK, raw `useWebSocket`. This is the standard seam from "a message arrived" to "this read is now stale".

```ts
import { z } from 'zod'

const jobEvent = z.object({ siteId: z.string(), status: z.string() })

useNuxtSubscription({
  // Inject the transport. Client-only, established after hydration. Wire
  // teardown to `ctx.signal` and/or return a cleanup function.
  source: ctx => connectChannel('job-status', ctx.push),
  // Parse the untrusted frame once, at the boundary.
  schema: jobEvent,
  // Map the parsed message to cache operations. Explicit by design: you
  // decide which reads move, the same as a mutation's `invalidates`.
  onMessage: e => invalidateNuxtQueries(`sites:${e.siteId}`),
})
```

It mirrors the rest of the package: callbacks run inside the Nuxt context (so the global cache helpers and composables resolve), failures surface through `onError` and an `error` ref rather than being swallowed, and `status` reports bridge establishment (`idle` / `connecting` / `active` / `error`).

**`source` may call composables.** It runs in its own effect scope, so if your transport is itself a composable (`useWebSocket`, a channel composable), call it directly in `source`; its `onScopeDispose` and watchers are torn down with the subscription. Create them synchronously (before any `await`); only the synchronous portion of an async source is scoped.

**Reconnect is a boundary you wire up yourself.** The bridge only sees messages that arrive; events missed while the socket was down are not its concern. Cold-start recovery stays with `useNuxtQuery`'s refetch-on-mount. For mid-session reconnects, run `onReconnect`, typically a wider invalidation that catches up everything that drifted while disconnected. If the transport exposes a connection-status ref, `ctx.resyncOn` wires it for you (it fires `onReconnect` on every reconnect, never the initial connect); otherwise call `ctx.resync()` yourself:

```ts
useNuxtSubscription({
  source: (ctx) => {
    const { status } = connectChannel('job-status', ctx.push) // returns a status ref
    ctx.resyncOn(status, s => s === 'open') // fire onReconnect on each re-open
  },
  onMessage: e => invalidateNuxtQueries(`sites:${e.siteId}`),
  onReconnect: () => invalidateNuxtQueries('sites:'),
})
```

**Coalescing is yours.** Each `invalidateNuxtQueries` triggers a refresh, so a burst of progress events means a burst of refetches. For chatty channels, debounce inside `onMessage` (the package leaves this decision to you):

```ts
import { useDebounceFn } from '@vueuse/core'

const sync = useDebounceFn(() => invalidateNuxtQueries(`sites:${id}`), 400)
useNuxtSubscription({ source: connectSocket, onMessage: () => sync() })
```

### WebSocket Source

`nuxtWebSocketSource` is a ready-made `source` over VueUse's `useWebSocket` (already a dependency, so no extra weight). It maps frames to `ctx.push`, calls `ctx.resync()` on every reconnect, and closes the socket on teardown. Heartbeat and auto-reconnect are VueUse built-ins, passed straight through:

```ts
useNuxtSubscription({
  source: nuxtWebSocketSource('wss://example.com/ws', {
    heartbeat: true,
    autoReconnect: true,
  }),
  schema: jobEvent,
  onMessage: e => invalidateNuxtQueries(`sites:${e.siteId}`),
  onReconnect: () => invalidateNuxtQueries('sites:'),
})
```

String frames are JSON-parsed by default (non-JSON frames pass through for `schema` to handle); pass `deserialize` to override. For other transports (SSE, a vendor SDK), write a `source` that calls `ctx.push` per message and returns a cleanup function.

## RPC error handling

RPC clients can attach shared telemetry or toast handling. `$fetch` / HTTP failures and Zod request/response validation failures are normalized before they reach hooks or callers.

```ts
import { toHumanNuxtRpcError } from '@harlan-zw/nuxt-use-query/rpc'

const rpc = useNuxtRpc({
  onError({ error, operation }) {
    console.error(operation.path, toHumanNuxtRpcError(error))
  },
})

await rpc.execute(siteQueries.update(siteId.value), { name: 'Docs' }, {
  silent: true, // skip onError for flows that handle their own UX
})
```

`useNuxtRpcQuery` takes its own `onError`. The client hook above covers `rpc.query` / `rpc.execute` only, so a reactive query needs this one:

```ts
const sites = useNuxtRpcQuery(siteQueries.list(), {
  onError({ error, operation, durationMs }) {
    console.error(operation.path, toHumanNuxtRpcError(error), durationMs)
  },
})
```

It fires once per failure, in the browser only. A failure raised during SSR is transferred in the payload and reported on hydration, so it is never reported twice.

A `NuxtRpcError` is a real `Error` named `NuxtRpcError`. It carries the `type` discriminant and its variant payload, so `captureException` keeps the message and stack instead of stringifying a plain object.

The module registers a payload reducer and reviver for it, so a failure raised during SSR crosses into the browser with its tag intact. The `cause` and `response` fields do not cross: they hold a `FetchError` and a `Response`, which cannot be serialized.

## Server fetch telemetry

Enable server-side fetch telemetry to wrap Nitro's global `$fetch` during SSR. It also applies a default server `$fetch` timeout unless a call or created fetcher already provides one. It logs:

- `slow fetch` when a completed server fetch exceeds `slowFetchThreshold`.
- `large HTTP payload` when a completed server fetch's response `Content-Length` exceeds `largePayloadThreshold` (default `300_000` bytes).
- `fetch timeout` when a server fetch is aborted by the configured timeout.
- `fetch waterfall` when one incoming request runs a chain of dependent fetches. The rule measures chain depth, not parallelism: a render can be six levels deep and seven fetches wide at each level, which is a waterfall even though it looks highly parallel. A chain is reported when the fetch span exceeds `waterfallThreshold`, the chain holds at least `waterfallMinChainDepth` serial levels, it explains at least `waterfallMinCriticalPathShare` of the wall time, and it costs at least `waterfallMinChainBeyondSlowestMs` more than its slowest single link. The warning lists the critical path plus an aligned timeline of tracked `$fetch` calls.
- `duplicate fetch` when one incoming request repeats the same internal GET **path** at least `duplicateFetchThreshold` times. The query string is collected as a variant, not used as part of the key, because the query cache already coalesces identical urls. The repeat that costs real time is one handler entered once per filtered slice.
- `nested fetch` when internal Nitro fetches chain at least `nestedFetchDepthThreshold` levels deep.
- `recursive fetch` when an internal Nitro fetch calls a route already in its request stack.

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-use-query'],
  nuxtUseQuery: {
    telemetry: {
      enabled: true,
      timeout: 20_000,
      duplicateFetchThreshold: 2,
      nestedFetchDepthThreshold: 3,
      recursiveFetchWarning: true,
      slowFetchThreshold: 3_000,
      largePayloadThreshold: 300_000,
      waterfallMinFetches: 2,
      waterfallThreshold: 3_000,
      waterfallMinChainDepth: 2,
      waterfallMinCriticalPathShare: 0.75,
      waterfallMinChainBeyondSlowestMs: 1_000,
      console: true,
      debug: false,
    },
  },
})
```

Use `telemetry: true` for the defaults. Set `timeout: false` to disable the default timeout, or pass `timeout` per `$fetch` call to override it. Set `duplicateFetchThreshold: false`, `nestedFetchDepthThreshold: false`, or `recursiveFetchWarning: false` to disable those specific internal-fetch warnings. Set `debug: true` to also log per-fetch timing and per-request summaries, including the per-request timeline. Set `console: false` to keep hook events enabled while suppressing package console output, including slow fetch, large payload, timeout, waterfall, duplicate, nested, and recursive warnings.

Keep every `slowFetchThreshold` below `timeout`. A fetch is aborted at the timeout, so a threshold at or above it can never be reached and the signal is dead. The module warns at build time when a default or per-host threshold breaks this rule. To turn slow detection off, set the threshold to `false`; do not raise it above the timeout.

`largePayloadThreshold` defaults to `300_000` bytes (mirroring Sentry's Large HTTP Payload detector). Like `slowFetchThreshold`, it accepts a per-host map so you can mute an upstream whose big responses are expected while keeping detection everywhere else, a plain `false`/`0` to turn it off globally, or a per-`$fetch`-call override:

```ts
const largePayloadThreshold = {
  default: 300_000,
  hosts: {
    // a data/export API whose big responses are expected, so silence it
    'searchconsole.googleapis.com': false,
  },
}
// off globally: largePayloadThreshold: false
// or per call:  $fetch('/api/export', { largePayloadThreshold: false })
```

Detection is **header-only**: it reads the response `Content-Length` (wire bytes, so compressed when the response is encoded) and never sizes the parsed body, keeping it cheap on the hot path. Responses that omit `Content-Length` (streamed/chunked) are silently skipped, and the capture interceptor is skipped for muted hosts and per-call opt-outs.

Telemetry also emits hook events so apps can send data to their own logger/APM without parsing console output.

During SSR, fetches made through `useFetch`, `useRequestFetch`, Nitro `event.$fetch`, and the default `useNuxtRpc()` client are attributed to the active request and included in the request summary. A raw app-side `$fetch('/api/...')` still emits the fetch hook, but Nuxt may not expose request context to that global call, so `event.request` and summary attribution can be absent. Use `useRequestFetch()` or the default `useNuxtRpc()` fetcher when request attribution matters.

For server `$fetch` telemetry, attach Nitro hooks from a server plugin:

```ts
import {
  formatDuplicateFetchTelemetryEvent,
  formatFetchTimeoutTelemetryEvent,
  formatFetchWaterfallTelemetryEvent,
  formatLargePayloadTelemetryEvent,
  formatNestedFetchTelemetryEvent,
  formatRecursiveFetchTelemetryEvent,
  formatSlowFetchTelemetryEvent,
  NUXT_USE_QUERY_TELEMETRY_HOOKS,
} from '@harlan-zw/nuxt-use-query/telemetry'
import { defineNitroPlugin } from 'nitropack/runtime'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSlow, (event) => {
    console.warn(formatSlowFetchTelemetryEvent(event))
  })

  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchLargePayload, (event) => {
    console.warn(formatLargePayloadTelemetryEvent(event))
  })

  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchTimeout, (event) => {
    console.warn(formatFetchTimeoutTelemetryEvent(event))
  })

  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchWaterfall, (event) => {
    console.warn(formatFetchWaterfallTelemetryEvent(event))
  })

  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchDuplicate, (event) => {
    console.warn(formatDuplicateFetchTelemetryEvent(event))
  })

  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchNested, (event) => {
    console.warn(formatNestedFetchTelemetryEvent(event))
  })

  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchRecursive, (event) => {
    console.warn(formatRecursiveFetchTelemetryEvent(event))
  })
})
```

For Nuxt app-side query telemetry, attach hooks from a Nuxt plugin:

```ts
import {
  formatQueryTelemetryFinishEvent,
  NUXT_USE_QUERY_TELEMETRY_HOOKS,
} from '@harlan-zw/nuxt-use-query/telemetry'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, (event) => {
    console.info(formatQueryTelemetryFinishEvent(event))
  })
})
```

## Contract enforcement

Enable build-time enforcement when a project is ready to make the pattern mandatory:

```ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/nuxt-use-query'],
  nuxtUseQuery: {
    contracts: {
      enabled: true,
      // 'error' fails the build (default); 'warn' logs and continues.
      severity: 'error',
      apiPrefixes: ['/api/pro'],
      queryDirs: ['app/queries', 'layers/*/app/queries'],
      contractDirs: ['shared/contracts', 'layers/*/shared/contracts'],
      requireServerContracts: true,
      serverApiDirs: ['server/api', 'layers/*/server/api'],
      // Directories the scanner walks, relative to the project root.
      scanDirs: ['app', 'server', 'shared', 'modules', 'layers/**/app', 'layers/**/server', 'layers/**/shared'],
      // Paths to skip, on top of the built-in ones (node_modules, .nuxt, ...).
      ignore: ['app/generated'],
    },
  },
})
```

With enforcement enabled:

- API path literals must live in configured query directories.
- Query files must define Zod-backed RPC operations.
- Server API routes can be required to import shared contracts.

### Path Patterns

`queryDirs`, `contractDirs`, `serverApiDirs`, `scanDirs`, and `ignore` share one pattern syntax:

- `*` matches one path segment, `**` matches any number of segments, `?` matches one character.
- A pattern matches anywhere in the path, not only at the project root. `app/queries` therefore also covers `layers/pro/site/app/queries`, which is where a layered site keeps them.

### What The Scanner Accepts

- Server code is exempt from `api-literal-outside-query`. A route, a middleware, and a server util all read or call internal API paths by design. `server-route-missing-contract` still polices the routes.
- Operation factories resolve through aliases. `import { defineNuxtRpcQuery as defineProQuery }`, `export { defineNuxtRpcQuery as defineProQuery }`, and `const defineProQuery = defineNuxtRpcQuery` all count as operations.
- Inside a query directory, any factory call whose first argument is an operation object counts as an operation. The object must name a `path` plus a `key` (query) or a `method` (mutation). This covers a layer's own scoped factory, whose name cannot be resolved across files.

Start without enforcement while migrating an existing site, then enable it once queries and contracts have been moved into the recommended directories.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-use-query/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fnuxt-use-query/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/nuxt-use-query

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fnuxt-use-query.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/nuxt-use-query

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/nuxt-use-query/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
