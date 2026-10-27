import { getQueryData, setQueryData } from '@harlan-zw/nuxt-use-query/query-cache'
import { beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const state = vi.hoisted(() => ({ app: undefined as unknown as ReturnType<typeof fixture> }))
vi.mock('#app', () => ({ useNuxtApp: () => state.app, clearNuxtData: vi.fn(), refreshNuxtData: vi.fn() }))

function fixture() {
  return {
    _asyncData: {
      owned: { data: ref<unknown>({ count: 42 }), error: ref<unknown>(undefined), status: ref('success') },
    },
    payload: { data: { owned: { count: 42 } } as Record<string, unknown> },
    static: { data: { owned: { count: 7 }, other: { count: 8 } } as Record<string, unknown> },
  }
}

beforeEach(() => {
  state.app = fixture()
})

it('clears refused data from the public cache without clearing its error or status', () => {
  const error = Object.assign(new Error('Forbidden'), { status: 403 })
  const live = state.app._asyncData.owned
  live.data.value = undefined
  state.app.payload.data.owned = undefined
  live.error.value = error
  live.status.value = 'error'

  expect(setQueryData('owned', undefined)).toEqual({ count: 7 })
  expect(getQueryData('owned')).toBeUndefined()
  expect(live.error.value).toBe(error)
  expect(live.status.value).toBe('error')
  expect(getQueryData('other')).toEqual({ count: 8 })
})

it.each([{ count: 99 }, null])('keeps an explicit write authoritative over older extracted data: %s', (next) => {
  expect(setQueryData('owned', next)).toEqual({ count: 42 })
  expect(getQueryData('owned')).toEqual(next)

  state.app._asyncData.owned.data.value = undefined
  state.app.payload.data.owned = undefined

  expect(getQueryData('owned')).toEqual(next)
  expect(getQueryData('other')).toEqual({ count: 8 })
})
