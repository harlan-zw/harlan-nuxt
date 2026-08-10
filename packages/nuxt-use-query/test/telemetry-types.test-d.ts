import type { NitroApp } from 'nitropack/types'
import type { NuxtApp } from 'nuxt/app'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from '@harlanzw/nuxt-use-query/telemetry'
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
        expectTypeOf(event.timeline).toEqualTypeOf<Array<{
          durationMs: number
          endedAt: number
          method: string
          offsetMs: number
          ok: boolean
          startedAt: number
          url: string
        }>>()
        expectTypeOf(event.upstreamMs).toEqualTypeOf<number>()
        expectTypeOf(event.thresholdMs).toEqualTypeOf<number>()
      })

      hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchDuplicate, (event) => {
        expectTypeOf(event.count).toEqualTypeOf<number>()
        expectTypeOf(event.threshold).toEqualTypeOf<number>()
        expectTypeOf(event.url).toEqualTypeOf<string>()
      })

      hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchNested, (event) => {
        expectTypeOf(event.depth).toEqualTypeOf<number>()
        expectTypeOf(event.stack).toEqualTypeOf<string[]>()
      })

      hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchRecursive, (event) => {
        expectTypeOf(event.depth).toEqualTypeOf<number>()
        expectTypeOf(event.stack).toEqualTypeOf<string[]>()
      })

      hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchTimeout, (event) => {
        expectTypeOf(event.timeoutMs).toEqualTypeOf<number>()
        expectTypeOf(event.error).toEqualTypeOf<unknown>()
      })

      hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchLargePayload, (event) => {
        expectTypeOf(event.bytesLength).toEqualTypeOf<number>()
        expectTypeOf(event.thresholdBytes).toEqualTypeOf<number>()
        expectTypeOf(event.url).toEqualTypeOf<string>()
      })
    }
  })
})
