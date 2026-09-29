<h1>@harlan-zw/nuxt-use-query</h1>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

Nuxt Use Query adds TanStack-shaped composables to Nuxt's own data layer. Caching, SWR, and invalidation run through the Nuxt payload, so you have no second cache to keep in sync.

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

- 🔄 **Queries and mutations:** Pages refetch stale data, poll, and roll back failed optimistic writes without a second cache beside `useFetch`.
- 📇 **Typed RPC contracts:** Components stop hardcoding API URLs, and [Zod](https://zod.dev) catches contract drift at the boundary instead of deep in the app.
- 🗝️ **Cache control:** One write can refresh or patch every query it affects, in the Nuxt payload and in live `_asyncData` state.
- ⚡ **Realtime bridge:** WebSocket, SSE, or vendor SDK messages mark the right queries stale, and your connection code stays yours ([VueUse](https://vueuse.org) adapter included).
- 🧵 **SSR-safe by construction:** Cache state never leaks between users, because it lives on each request's Nuxt app instance.

## Installation

Install `@harlan-zw/nuxt-use-query` in your Nuxt site:

```bash
npx nuxi@latest module add @harlan-zw/nuxt-use-query
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/nuxt-use-query
> ```

If your site defines RPC contracts, add Zod as a direct dependency:

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

If you use the helpers outside Nuxt's auto-import scan, import them from subpaths:

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

The module has two layers, and both share one cache. Pick by who owns the contract:

| Use this                                       | When                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **RPC layer** (`defineNuxtRpc*` + `useNuxtRpcQuery` / `useNuxtRpc().execute`) | You own both sides of the call. Use it by default for user-facing calls and for calls imported in more than one place.                     |
| **Query layer** (`useNuxtQuery` / `useNuxtMutation` directly) | Escape hatch for third-party APIs, one-off internal calls, prototypes, and file downloads or blobs, where a Zod schema adds nothing.        |

The RPC composables wrap `useNuxtQuery`, so both layers live in the same cache and respond to the same `invalidateNuxtQueries(prefix)` calls. You can mix them in one app.

**Why RPC is the default:** the operation object owns the API path, cache key, method, and Zod request and response schemas. Components import the operation and never see the URL. If you rename an endpoint, you change one line. The schema catches contract drift at the boundary, before it spreads through the app as `unknown`.

**Why the escape hatch exists:** a contract for a fetch you call once costs time and protects nothing. If no second caller exists, call `useNuxtQuery` directly.

**Mutations stay manual.** The package has no `useNuxtRpcMutation` composable. Use `useNuxtMutation` with `rpc.execute(operation, body)` (see [Execute Mutations](#4-execute-mutations)). You write the `invalidates` list by hand, because a mutation operation cannot know which queries to refresh. An auto-wrapper would hide that decision from you.

## Query defaults

`useNuxtQuery` follows TanStack Query's important defaults where Nuxt primitives allow:

- `staleTime` defaults to `0`, so cached data is stale immediately and can refetch on mount, focus, or reconnect.
- `gcTime` defaults to 5 minutes. After that, inactive payload data is evicted.
- `refetchOnMount`, `refetchOnWindowFocus`, and `refetchOnReconnect` default to `true`; pass `'always'` to bypass the stale check.
- `staleTime: Infinity` and `staleTime: 'static'` treat data as immutable until you invalidate it.
- `isPlaceholderData`, `isPending`, and `isFetching` sit beside the Nuxt `status` ref.

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

Use the same schemas in server routes and in client query operations. Then both sides agree on the request and response shape.

### 2. Define Query Operations

Define each API operation beside the feature that owns it. Import the shared Zod schemas from the contracts folder. Components use operations and never hardcode URLs.

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

The operation object is the one owner of the API path, cache key, method, body schema, and response schema.

#### Defer Large Schema Groups

If the Zod code makes the first client chunk too large, defer it with a schema group:

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

The contracts module loads once. Every selected schema keeps its exact input and output types.

Parsing always waits for the schema group. A load failure returns a retryable `schema-load` RPC error.

Cached POST query bodies still parse eagerly, because the parsed body forms the synchronous cache key.

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

`useNuxtRpcQuery` wraps `useNuxtQuery`. It takes the same cache and refetch options, and it validates the response with the operation's Zod schema.

### 4. Execute Mutations

```ts
import { siteQueries } from '~/queries/sites'

const rpc = useNuxtRpc()

async function saveSite(name: string | null) {
  await rpc.execute(siteQueries.update(siteId.value), { name })
  invalidateNuxtQueries(`sites:${siteId.value}`)
}
```

If the view needs pending or error state, lifecycle hooks, or optimistic cache writes, use `useNuxtMutation`:

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

Skip the RPC layer when the contract is not yours to define, or when a Zod schema adds nothing. Examples are third-party APIs, one-off internal calls, prototypes, and file downloads.

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

`useNuxtQuery` accepts every Nuxt `useFetch` option and adds these:

- `key`: required stable cache key.
- `enabled`: blocks the first request and later refreshes until it is true.
- `staleTime`: time in milliseconds before cached data is stale. Use `Infinity` or `'static'` for immutable data.
- `gcTime`: time before inactive payload data is evicted. Defaults to 5 minutes.
- `keepPreviousData`: exposes previous data through `displayData` while a new key loads. Defaults to true.
- `refetchInterval`: polling interval in milliseconds.
- `refetchOnMount`, `refetchOnWindowFocus`, and `refetchOnReconnect`: pass `true`, `false`, or `'always'`.

`useNuxtQuery` shares the cache with RPC queries, so `invalidateNuxtQueries('sites:')` from either layer refreshes both.

### Server Deadline

If some data should not hold up the whole render, set a server deadline:

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

`useNuxtSubscription` turns realtime messages into explicit cache operations. It does **not** own a connection. You pass the transport in through `source`. The connection, with its auth, channels, and reconnect logic, stays with whatever owns it now: a [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) module, a vendor SDK, or raw `useWebSocket`. The subscription is the one place where "a message arrived" becomes "this query is now stale".

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

It follows the same rules as the rest of the package:

- Callbacks run inside the Nuxt context, so the global cache helpers and composables resolve.
- Failures reach `onError` and an `error` ref. Nothing is swallowed.
- `status` reports the connection state of the subscription: `idle`, `connecting`, `active`, or `error`.

**`source` may call composables.** `source` runs in its own effect scope. If your transport is a composable, such as `useWebSocket` or a channel composable, call it directly in `source`. Its `onScopeDispose` handlers and watchers stop when the subscription stops. Call composables before the first `await`, because only the synchronous part of an async `source` is scoped.

**You wire up reconnect yourself.** The subscription only sees messages that arrive. It never sees messages sent while the socket was down. On a cold start, `useNuxtQuery` refetches on mount. For a reconnect mid-session, use `onReconnect`, usually with a wider invalidation that catches up on what changed. If the transport exposes a connection status ref, pass it to `ctx.resyncOn`. It fires `onReconnect` on every reconnect, never on the first connect. Otherwise, call `ctx.resync()` yourself:

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

**You own coalescing.** Each `invalidateNuxtQueries` call starts a refresh, so a burst of progress events causes a burst of refetches. If a channel is chatty, debounce inside `onMessage`:

```ts
import { useDebounceFn } from '@vueuse/core'

const sync = useDebounceFn(() => invalidateNuxtQueries(`sites:${id}`), 400)
useNuxtSubscription({ source: connectSocket, onMessage: () => sync() })
```

### WebSocket Source

`nuxtWebSocketSource` is a ready-made `source` built on VueUse's `useWebSocket`. VueUse is already a dependency, so it adds no weight. It sends each frame to `ctx.push`, calls `ctx.resync()` on every reconnect, and closes the socket on teardown. It passes the VueUse heartbeat and auto-reconnect options straight through:

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

By default, it parses string frames as JSON. A frame that is not JSON passes through unchanged, for `schema` to handle. To change this, pass `deserialize`. For other transports, such as SSE or a vendor SDK, write a `source` that calls `ctx.push` for each message and returns a cleanup function.

## RPC error handling

An RPC client can attach shared telemetry or toast handling. The client normalizes each failure before it reaches a hook or caller. This covers `$fetch` and HTTP failures, and Zod request and response validation failures.

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

The client hook above covers only `rpc.query` and `rpc.execute`. A reactive query needs its own `onError` on `useNuxtRpcQuery`:

```ts
const sites = useNuxtRpcQuery(siteQueries.list(), {
  onError({ error, operation, durationMs }) {
    console.error(operation.path, toHumanNuxtRpcError(error), durationMs)
  },
})
```

It fires once per failure, in the browser only. A failure during SSR travels in the payload and is reported on hydration, so it never reports twice.

A `NuxtRpcError` is a real `Error` named `NuxtRpcError`. It carries the `type` discriminant and its variant payload, so `captureException` keeps the message and stack instead of stringifying a plain object.

The module registers a payload reducer and reviver for it, so a failure raised during SSR crosses into the browser with its tag intact. The `cause` and `response` fields do not cross: they hold a `FetchError` and a `Response`, which cannot be serialized.

### Response Validation: `strict` / `lenient` / `auto`

`responseValidation` sets what happens when a response payload does not match its Zod schema:

- **`strict`**: throws a `response-validation` `NuxtRpcError`.
- **`lenient`**: recovers, because the server wins over a stale or over-eager client contract. It returns the raw payload unparsed and calls `onError` with `recovered: true`, so telemetry still sees the mismatch. On the client, it also logs the normalized error with `console.error`.
- **`auto`** (the default): uses `strict` in a dev build and `lenient` in production, based on Nuxt's `import.meta.dev`. In development, you want to see a mismatch at once. In production, one bad row should not blank the page.

Request bodies always validate strictly. Only response payloads can be lenient.

Override the default per operation:

```ts
export const siteQueries = defineNuxtQueryGroup('sites', {
  // A field the server already renamed, still read by an older client build.
  // Force this one lenient in every build, not just production.
  detail: (siteId: string) => defineNuxtRpcQuery({
    key: ['sites', siteId],
    path: `/api/sites/${siteId}`,
    response: siteSchema,
    responseValidation: 'lenient',
  }),
})
```

You can also set a default once, on `useNuxtRpc(...)`, `createNuxtRpcClient(...)`, or `useNuxtRpcQuery(operation, { responseValidation: 'auto' | 'strict' | 'lenient' })`. Resolution order: **the operation's own `responseValidation` wins, then the client or scope default, then `'auto'`.**

Lenient validation also works for a schema slot with `parse` and no `safeParse`, such as a deferred `defineNuxtRpcSchemaGroup` entry. In that case it wraps `parse` in a try/catch.

`isDev` overrides how `'auto'` picks between dev and production. You can set it on `useNuxtRpc`, `createNuxtRpcClient`, and `useNuxtRpcQuery`. It defaults to `import.meta.dev`. Set it only if `import.meta.dev` is the wrong signal for a client, or if a test must force one branch of `'auto'`.

The `onError` on `useNuxtRpcQuery` (see [RPC error handling](#rpc-error-handling)) also fires for a recovered mismatch, with `recovered: true`. Unlike a real failure, a recovered mismatch fires where the fetch ran, SSR included. It never throws, so it never reaches the AsyncData error and payload path. Hydration does not run `transform` again, so the client would never see it.

## Server fetch telemetry

Server fetch telemetry wraps Nitro's global `$fetch` during SSR. It also sets a default server `$fetch` timeout, unless a call or a created fetcher sets its own. It logs these warnings:

- `slow fetch` when a completed server fetch exceeds `slowFetchThreshold`.
- `large HTTP payload` when a completed server fetch's response `Content-Length` exceeds `largePayloadThreshold` (default `300_000` bytes).
- `fetch timeout` when a server fetch is aborted by the configured timeout.
- `fetch waterfall` when one incoming request runs a chain of dependent fetches. The rule measures chain depth. A render six levels deep with seven parallel fetches per level looks parallel, but it is still a waterfall. The module reports a chain when all of these hold: the fetch span exceeds `waterfallThreshold`, the chain has at least `waterfallMinChainDepth` serial levels, it covers at least `waterfallMinCriticalPathShare` of the wall time, and it takes at least `waterfallMinChainBeyondSlowestMs` longer than its slowest single link. The warning lists the critical path and an aligned timeline of tracked `$fetch` calls.
- `duplicate fetch` when one incoming request repeats the same internal GET **path** at least `duplicateFetchThreshold` times. The key ignores the query string and records it as a variant, because the query cache already merges identical URLs. The costly repeat is one handler called once for each filtered slice.
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

For the defaults, use `telemetry: true`. To disable the default timeout, set `timeout: false`. To override it for one call, pass `timeout` to that `$fetch` call. To disable an internal fetch warning, set `duplicateFetchThreshold: false`, `nestedFetchDepthThreshold: false`, or `recursiveFetchWarning: false`. To also log per-fetch timing and per-request summaries with their timelines, set `debug: true`. To keep hook events but silence every package console warning, set `console: false`.

Keep every `slowFetchThreshold` below `timeout`. The timeout aborts the fetch, so a threshold at or above it never fires. The module warns at build time if a default or per-host threshold breaks this rule. To turn off slow detection, set the threshold to `false`. Do not raise it above the timeout.

`largePayloadThreshold` defaults to `300_000` bytes, the same as Sentry's Large HTTP Payload detector. Like `slowFetchThreshold`, it accepts these forms:

- A per-host map, to mute one upstream whose large responses are expected.
- `false` or `0`, to turn detection off everywhere.
- An override on a single `$fetch` call.

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

Detection reads **headers only**. It checks the response `Content-Length`, which counts wire bytes, so an encoded response counts at its compressed size. It never measures the parsed body, so it stays cheap on the hot path. It skips a response with no `Content-Length`, such as a chunked one, and logs nothing. It also skips the capture interceptor for muted hosts and per-call opt-outs.

Telemetry also emits hook events. Your app can send them to its own logger or APM without parsing console output.

During SSR, the module ties each fetch to the active request and adds it to the request summary. This covers `useFetch`, `useRequestFetch`, Nitro `event.$fetch`, and the default `useNuxtRpc()` client. A raw app-side `$fetch('/api/...')` still emits the fetch hook. But Nuxt may not give that global call the request context, so `event.request` and summary attribution can be missing. If attribution matters, use `useRequestFetch()` or the default `useNuxtRpc()` fetcher.

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

When a project is ready to make the pattern mandatory, enable build-time enforcement:

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
- You can require server API routes to import shared contracts.

### Path Patterns

`queryDirs`, `contractDirs`, `serverApiDirs`, `scanDirs`, and `ignore` share one pattern syntax:

- `*` matches one path segment, `**` matches any number of segments, `?` matches one character.
- A pattern matches anywhere in the path, not only at the project root. `app/queries` therefore also covers `layers/pro/site/app/queries`, which is where a layered site keeps them.

### What The Scanner Accepts

- Server code is exempt from `api-literal-outside-query`, because routes, middleware, and server utils call internal API paths by design. `server-route-missing-contract` still checks the routes.
- Operation factories resolve through aliases. `import { defineNuxtRpcQuery as defineProQuery }`, `export { defineNuxtRpcQuery as defineProQuery }`, and `const defineProQuery = defineNuxtRpcQuery` all count as operations.
- Inside a query directory, any factory call whose first argument is an operation object counts as an operation. The object must name a `path` plus a `key` (query) or a `method` (mutation). This covers a layer's own scoped factory, whose name cannot be resolved across files.

If you are migrating an existing site, start without enforcement. Enable it after you move the queries and contracts into the recommended directories.

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
