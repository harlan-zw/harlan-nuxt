import type { NuxtRpcQueryErrorEvent } from '@harlan-zw/nuxt-use-query/rpc'
import { getQueryData, removeNuxtQueries, setQueryData } from '@harlan-zw/nuxt-use-query/query-cache'
import { defineNuxtRpcQuery, useNuxtRpcQuery } from '@harlan-zw/nuxt-use-query/rpc'
import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { z } from 'zod'
import { useNuxtApp } from '#app'

const scopes: Array<ReturnType<typeof effectScope>> = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  removeNuxtQueries('cache-write:')
})

it('keeps refused extracted data cleared through native query remount without changing its error', async () => {
  const key = 'cache-write:refused'
  const errors: NuxtRpcQueryErrorEvent[] = []
  const transport = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ value: 42 }))
    .mockImplementation(async () => Response.json({ statusMessage: 'Forbidden' }, { status: 403 }))
  const requestFetch = $fetch.create({ retry: 0 }, { fetch: transport })
  const operation = defineNuxtRpcQuery({ key, path: '/api/controlled-static-refusal', response: z.object({ value: z.number() }) })
  const read = () => {
    const scope = effectScope()
    scopes.push(scope)
    const query = scope.run(() => useNuxtRpcQuery(operation, {
      $fetch: requestFetch,
      immediate: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: 60_000,
      onError: event => errors.push(event),
    }))!
    return { scope, query }
  }
  const first = read()
  await first.query.refresh()
  expect(first.query.data.value).toEqual({ value: 42 })
  useNuxtApp().static.data[key] = { value: 7 }
  await first.query.refresh()
  await vi.waitFor(() => expect(errors).toHaveLength(1))
  const refusal = first.query.error.value
  expect(refusal).toMatchObject({ type: 'fetch', status: 403 })

  setQueryData(key, undefined)
  expect(getQueryData(key)).toBeUndefined()
  expect(first.query.error.value).toBe(refusal)
  expect(first.query.status.value).toBe('error')
  expect(errors).toHaveLength(1)

  first.scope.stop()
  const second = read()
  await nextTick()
  expect(getQueryData(key)).toBeUndefined()
  expect(second.query.data.value).toBeUndefined()
  expect(transport).toHaveBeenCalledTimes(2)
})
