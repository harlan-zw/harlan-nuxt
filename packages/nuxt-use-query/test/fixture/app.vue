<script setup lang="ts">
import { z } from 'zod'

// Exercises the module's auto-imports during SSR so the e2e test can read the
// resolved values from the prerendered HTML. `useNuxtQuery` runs server-side
// (default `immediate: true`), so the data is present in the response body
// before any client hydration is needed.

const echoSchema = z.object({
  call: z.number(),
  value: z.string(),
})

const { data: a } = await useNuxtQuery<{ value: string, call: number }>('/api/echo', {
  key: 'echo-a',
  query: { token: 'fixture-secret-token', v: 'a' },
})

const { data: b } = await useNuxtQuery<{ value: string, call: number }>('/api/echo', {
  key: 'echo-b',
  query: { v: 'b' },
})

const echoQueries = defineNuxtQueryGroup('fixture', {
  detail: (value: string) => defineNuxtRpcQuery({
    key: ['fixture', value],
    path: '/api/echo',
    query: { v: value },
    response: echoSchema,
  }),
})

const searchResponseSchema = z.object({
  limit: z.number(),
  term: z.string(),
})
const searchBodySchema = z.object({
  limit: z.number().default(10),
  term: z.string().trim(),
})
const postQuery = defineNuxtRpcQuery({
  key: ['fixture', 'search'],
  method: 'POST',
  idempotent: true,
  path: '/api/search',
  body: {
    schema: searchBodySchema,
    value: { term: ' reactive ', ignored: true },
  },
  response: searchResponseSchema,
})

const { data: rpcQuery } = await useNuxtRpcQuery(echoQueries.detail('rpc-query'))
const { data: rpcPostQuery } = await useNuxtRpcQuery(postQuery)
const rpc = useNuxtRpc({ fetch: $fetch as any })
const rpcDirect = await rpc.query(echoQueries.detail('rpc-direct'))
const rpcPostDirect = await rpc.query(defineNuxtRpcQuery({
  key: ['fixture', 'search-direct'],
  method: 'POST',
  idempotent: true,
  path: '/api/search',
  body: { schema: searchBodySchema, value: { limit: 3, term: ' direct ' } },
  response: searchResponseSchema,
}))
const rpcDefault = await useNuxtRpc().query(echoQueries.detail('rpc-default'))
const appContextFetch = await $fetch<{ source: string }>('/api/app-context-fetch')
const mutationOperation = defineNuxtRpcMutation({
  method: 'DELETE',
  path: '/api/echo',
  response: echoSchema,
})
const rpcKey = serializeNuxtRpcKey(['fixture', 'rpc-query'])

// A query that fails during SSR. Proves the tagged error survives the render
// and that the payload still serializes with an `Error` in the error ref.
const failingQuery = defineNuxtRpcQuery({
  key: ['fixture', 'fail'],
  path: '/api/fail',
  response: echoSchema,
})
const { error: rpcQueryError } = await useNuxtRpcQuery(failingQuery)

// Resolve the cache that's been attached to the Nuxt app. `useQueryCache()`
// is the seam this whole module is built on. Stamp two keys directly to prove
// the returned object is a real, mutable cache (the SSR `pending → success`
// watch may not fire before <script setup> returns; we exercise it separately
// in the unit tests).
const cache = useQueryCache()
cache.lastFetched.set('manual-stamp-a', 1)
cache.lastFetched.set('manual-stamp-b', 2)
setQueryData('manual-write', { ok: true })
// Re-resolve and confirm we're getting the same instance back.
const cacheSameInstance = useQueryCache() === cache

// Reference each auto-import as a value (not via `typeof`) so unimport sees
// real usages and injects the symbols.
const importedFns = [
  useNuxtQuery,
  useNuxtMutation,
  useNuxtRpc,
  useNuxtRpcQuery,
  useQueryCache,
  invalidateNuxtQueries,
  removeNuxtQueries,
  getQueryData,
  setQueryData,
  defineNuxtQueryGroup,
  defineNuxtRpcQuery,
  defineNuxtRpcMutation,
  serializeNuxtRpcKey,
]

const probe = {
  a: a.value,
  appContextFetch,
  b: b.value,
  cacheKeys: Array.from(cache.lastFetched.keys()).sort(),
  cacheSameInstance,
  cachedManualWrite: getQueryData<{ ok: boolean }>('manual-write'),
  hasAutoImports: importedFns.every(fn => typeof fn === 'function'),
  mutationMethod: mutationOperation.method,
  rpcDirect,
  rpcPostDirect,
  rpcPostQuery: rpcPostQuery.value,
  rpcDefault,
  rpcKey,
  rpcQuery: rpcQuery.value,
  rpcQueryError: rpcQueryError.value
    ? { isError: rpcQueryError.value instanceof Error, name: rpcQueryError.value.name, status: rpcQueryError.value.type === 'fetch' ? rpcQueryError.value.status : undefined, type: rpcQueryError.value.type }
    : null,
}
</script>

<template>
  <div>
    <h1>nuxt-use-query fixture</h1>
    <pre id="probe">{{ JSON.stringify(probe) }}</pre>
  </div>
</template>
