<script setup lang="ts">
// Exercises the module's auto-imports during SSR so the e2e test can read the
// resolved values from the prerendered HTML. `useNuxtQuery` runs server-side
// (default `immediate: true`), so the data is present in the response body
// before any client hydration is needed.

const { data: a } = await useNuxtQuery<{ value: string, call: number }>('/api/echo', {
  key: 'echo-a',
  query: { v: 'a' },
})

const { data: b } = await useNuxtQuery<{ value: string, call: number }>('/api/echo', {
  key: 'echo-b',
  query: { v: 'b' },
})

// Resolve the cache that's been attached to the Nuxt app. `useQueryCache()`
// is the seam this whole module is built on. Stamp two keys directly to prove
// the returned object is a real, mutable cache (the SSR `pending → success`
// watch may not fire before <script setup> returns; we exercise it separately
// in the unit tests).
const cache = useQueryCache()
cache.lastFetched.set('manual-stamp-a', Date.now())
cache.lastFetched.set('manual-stamp-b', Date.now())
// Re-resolve and confirm we're getting the same instance back.
const cacheSameInstance = useQueryCache() === cache

// Reference each auto-import as a value (not via `typeof`) so unimport sees
// real usages and injects the symbols.
const importedFns = [useNuxtQuery, useNuxtMutation, useQueryCache, invalidateNuxtQueries]

const probe = {
  a: a.value,
  b: b.value,
  cacheKeys: Array.from(cache.lastFetched.keys()).sort(),
  cacheSameInstance,
  hasAutoImports: importedFns.every(fn => typeof fn === 'function'),
}
</script>

<template>
  <div>
    <h1>nuxt-use-query fixture</h1>
    <pre id="probe">{{ JSON.stringify(probe) }}</pre>
  </div>
</template>
