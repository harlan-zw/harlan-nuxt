# Nuxt Use Query

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Nuxt][nuxt-src]][nuxt-href]

> Nuxt-native query composables with SWR, invalidation, polling, and optimistic cache writes.

## Features

- `useNuxtQuery` wraps Nuxt `useFetch` with TanStack-style stale-time revalidation, polling, enabled gates, and previous-data display.
- `useNuxtMutation` wires mutations to query invalidation and optimistic cache rollback.
- `defineNuxtRpcQuery`, `defineNuxtRpcMutation`, `useNuxtRpcQuery`, and `useNuxtRpc` let apps centralize Client -> API contracts in query folders with Zod request/response schemas.
- Optional build-time contract enforcement flags API path literals outside query folders and query operations that skip shared contract imports or schemas.
- `invalidateNuxtQueries`, `getQueryData`, and `setQueryData` work with Nuxt payload and live `_asyncData` state.
- Cache bookkeeping is stored on the Nuxt app instance for SSR-safe per-request isolation.

## Query Defaults

`useNuxtQuery` follows TanStack Query's important defaults where Nuxt primitives allow it:

- `staleTime` defaults to `0`, so cached data is stale immediately and can refetch on mount, focus, or reconnect.
- `gcTime` defaults to 5 minutes for inactive payload eviction.
- `refetchOnMount`, `refetchOnWindowFocus`, and `refetchOnReconnect` default to `true`; pass `'always'` to bypass the stale check.
- `staleTime: Infinity` and `staleTime: 'static'` opt into immutable data until explicit invalidation.
- `isPlaceholderData`, `isPending`, and `isFetching` are exposed alongside the Nuxt `status` ref.

## Contract Queries

Define API operations beside the feature that owns them, and import shared Zod schemas from a contracts folder. Components should consume operations, not hardcoded URLs.

```ts
import { z } from 'zod'

export const siteSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
})

export const sitePatchSchema = z.object({
  name: z.string().nullable(),
}).strict()

export const siteQueries = {
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
}
```

```ts
const { data } = useNuxtRpcQuery(() => siteQueries.detail(siteId.value))
const rpc = useNuxtRpc()

await rpc.execute(siteQueries.update(siteId.value), { name: 'Docs' })
```

RPC clients can attach shared telemetry or toast handling. `$fetch` / HTTP
failures and Zod request/response validation failures are normalized before
they reach hooks or callers.

```ts
const rpc = useNuxtRpc({
  onError({ error, operation }) {
    console.error(operation.path, toHumanNuxtRpcError(error))
  },
})

await rpc.execute(siteQueries.update(siteId.value), { name: 'Docs' }, {
  silent: true, // skip onError for flows that handle their own UX
})
```

Enable build-time enforcement when a project is ready to make the pattern mandatory:

```ts
export default defineNuxtConfig({
  modules: ['nuxt-use-query'],
  nuxtUseQuery: {
    contracts: {
      enabled: true,
      apiPrefixes: ['/api/pro'],
      queryDirs: ['app/queries', 'layers/*/app/queries'],
      contractDirs: ['shared/contracts', 'layers/*/shared/contracts'],
      requireServerContracts: true,
      serverApiDirs: ['server/api', 'layers/*/server/api'],
    },
  },
})
```

## Installation

Install `nuxt-use-query`:

```bash
npx nuxi@latest module add nuxt-use-query
```

## License

[MIT](https://github.com/harlan-zw/nuxt-use-query/blob/main/LICENSE.md)

[npm-version-src]: https://img.shields.io/npm/v/nuxt-use-query/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/nuxt-use-query

[npm-downloads-src]: https://img.shields.io/npm/dm/nuxt-use-query.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/nuxt-use-query

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
