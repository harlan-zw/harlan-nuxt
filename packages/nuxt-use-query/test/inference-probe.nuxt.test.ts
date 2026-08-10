// Type-level probe — proves `useNuxtQuery` inherits Nitro route inference
// from `useFetch` when called WITHOUT an explicit generic. If this file
// compiles, the inference machinery works; the runtime assertions are
// sanity checks that the data is what Nitro returned.
//
// `useSiteOverviewView.ts` was kept on bare `useFetch` specifically because
// the previous wrapper signature collapsed the route-response type to
// `unknown`. With the overload mirroring `useFetch`'s generic chain in
// place, that work-around is no longer load-bearing.

import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useNuxtQuery } from 'nuxt-use-query/query'
import { describe, expect, expectTypeOf, it } from 'vitest'

registerEndpoint('/api/typed-probe', { method: 'GET', handler: () => ({ message: 'hello', count: 42 }) })

describe('nuxt-use-query · route inference', () => {
  it('infers the response shape from the Nitro route (no explicit generic)', async () => {
    const q = await useNuxtQuery('/api/typed-probe', { key: 'typed-probe' })

    // Static type assertion — would not compile if `data.value` were
    // inferred as `unknown` (the previous wrapper's behaviour).
    expectTypeOf(q.data.value).toEqualTypeOf<{ message: string, count: number } | null>()

    expect(q.data.value?.message).toBe('hello')
    expect(q.data.value?.count).toBe(42)
  })

  it('still honours an explicit generic when given', async () => {
    const q = await useNuxtQuery<{ count: number }>('/api/typed-probe', {
      key: 'typed-probe-explicit',
    })
    expectTypeOf(q.data.value).toEqualTypeOf<{ count: number } | null>()
    expect(q.data.value?.count).toBe(42)
  })
})
