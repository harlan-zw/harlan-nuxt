import type { NitroApp } from 'nitropack/types'
import type { NuxtApp } from 'nuxt/app'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from 'nuxt-use-query/telemetry'
import { describe, expectTypeOf, it } from 'vitest'

describe('telemetry hook types', () => {
  it('types Nuxt app telemetry hooks without casts', () => {
    if (false) {
      const hooks = {} as NuxtApp['hooks']

      hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, (event) => {
        expectTypeOf(event.key).toEqualTypeOf<string>()
        expectTypeOf(event.durationMs).toEqualTypeOf<number>()
        expectTypeOf(event.status).toEqualTypeOf<'error' | 'success'>()
      })
    }
  })

  it('types Nitro fetch telemetry hooks without casts', () => {
    if (false) {
      const hooks = {} as NitroApp['hooks']

      hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchWaterfall, (event) => {
        expectTypeOf(event.request).toEqualTypeOf<string>()
        expectTypeOf(event.upstreamMs).toEqualTypeOf<number>()
        expectTypeOf(event.thresholdMs).toEqualTypeOf<number>()
      })
    }
  })
})
