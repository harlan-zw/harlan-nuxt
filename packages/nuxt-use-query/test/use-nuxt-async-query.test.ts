import { createQueryCache } from '@harlan-zw/nuxt-use-query/cache'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from '@harlan-zw/nuxt-use-query/telemetry'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

let capturedHandler: ((nuxtApp: unknown, context: unknown) => Promise<unknown>) | undefined
let callHook: ReturnType<typeof vi.fn>
const cache = createQueryCache()
const query = {
  data: ref<unknown>(undefined),
  refresh: vi.fn(async () => {}),
  status: ref('idle'),
}

vi.mock('#app', () => ({
  clearNuxtData: vi.fn(),
  useAsyncData: (_key: unknown, handler: (nuxtApp: unknown, context: unknown) => Promise<unknown>) => {
    capturedHandler = handler
    return query
  },
  useNuxtApp: () => ({ hooks: { callHook } }),
  useRuntimeConfig: () => ({ public: { nuxtUseQuery: { telemetry: { enabled: true } } } }),
}))

vi.mock('@vueuse/core', () => ({
  createSharedComposable: (composable: (...args: any[]) => unknown) => composable,
  useDocumentVisibility: () => ref('visible'),
  useEventListener: vi.fn(),
  useIntervalFn: vi.fn(),
  useOnline: () => ref(true),
}))

vi.mock('../src/runtime/composables/useQueryCache', async () => {
  const real = await vi.importActual<typeof import('../src/runtime/composables/useQueryCache')>(
    '../src/runtime/composables/useQueryCache',
  )
  return { ...real, useQueryCache: () => cache }
})

const { useNuxtAsyncQuery } = await import('@harlan-zw/nuxt-use-query/async-query')

beforeEach(() => {
  capturedHandler = undefined
  callHook = vi.fn(async () => {})
  query.data.value = undefined
  query.status.value = 'idle'
  query.refresh.mockClear()
})

describe('useNuxtAsyncQuery telemetry', () => {
  it('attributes a completion to the key used when the handler started', async () => {
    let resolve!: (value: string) => void
    const response = new Promise<string>((done) => {
      resolve = done
    })
    const key = ref('first')
    useNuxtAsyncQuery(() => response, { key })

    const pending = capturedHandler!({}, {})
    key.value = 'second'
    resolve('ok')
    await pending

    expect(callHook).toHaveBeenCalledWith(
      NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish,
      expect.objectContaining({ key: 'first', request: 'first', status: 'success' }),
    )
  })

  it('forwards Nuxt handler context while telemetry is enabled', async () => {
    const nuxtApp = { id: 'app' }
    const context = { signal: new AbortController().signal }
    const handler = vi.fn(async () => 'ok')
    useNuxtAsyncQuery(handler, { key: 'query' })

    await capturedHandler!(nuxtApp, context)

    expect(handler).toHaveBeenCalledWith(nuxtApp, context)
  })
})
