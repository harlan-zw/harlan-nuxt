import type { NuxtRpcQueryErrorEvent } from '@harlan-zw/nuxt-use-query/rpc'
import { defineNuxtRpcQuery, useNuxtRpcQuery } from '@harlan-zw/nuxt-use-query/rpc'
import { afterEach, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { z } from 'zod'
import { clearNuxtData } from '#app'

const scopes: Array<ReturnType<typeof effectScope>> = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  clearNuxtData(key => key.startsWith('rpc-network:'))
})

function queryFor(kind: 'connection' | 'timeout' | 'http500' | 'empty500' | 'http401' | 'validation') {
  const transport = vi.fn<typeof globalThis.fetch>(async () => {
    if (kind === 'connection')
      throw new TypeError('Failed to fetch')
    if (kind === 'timeout')
      throw new DOMException('The operation timed out', 'TimeoutError')
    if (kind === 'empty500')
      return new Response(null, { status: 500 })
    return Response.json({ value: 42 }, { status: kind === 'http500' ? 500 : kind === 'http401' ? 401 : 200 })
  })
  const requestFetch = $fetch.create({ retry: 0 }, { fetch: transport })
  const scope = effectScope()
  scopes.push(scope)
  const errors: NuxtRpcQueryErrorEvent[] = []
  const query = scope.run(() => useNuxtRpcQuery(defineNuxtRpcQuery({
    key: `rpc-network:${kind}`,
    path: `/api/controlled-${kind}`,
    response: z.object({ value: z.string() }),
    responseValidation: 'strict',
  }), {
    $fetch: requestFetch,
    immediate: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    onError: event => errors.push(event),
  }))!
  return { query, transport, errors }
}

it.each(['connection', 'timeout'] as const)('preserves a native %s failure through Nuxt useFetch and AsyncData', async (kind) => {
  const { query, transport, errors } = queryFor(kind)
  await query.refresh()
  await vi.waitFor(() => expect(errors).toHaveLength(1))
  expect(transport).toHaveBeenCalledOnce()
  expect(query.status.value).toBe('error')
  expect(query.error.value).toMatchObject({ type: kind })
  expect(errors[0]?.error).toBe(query.error.value)
})

it.each(['http500', 'empty500'] as const)('keeps a genuine %s as a server failure through the same native workflow', async (kind) => {
  const { query, transport, errors } = queryFor(kind)
  await query.refresh()
  await vi.waitFor(() => expect(errors).toHaveLength(1))
  expect(transport).toHaveBeenCalledOnce()
  expect(query.error.value).toMatchObject({ type: 'fetch', status: 500 })
  expect(errors[0]?.error).toBe(query.error.value)
})

it('keeps an actual HTTP401 as an authentication failure', async () => {
  const { query, errors } = queryFor('http401')
  await query.refresh()
  await vi.waitFor(() => expect(errors).toHaveLength(1))
  expect(query.error.value).toMatchObject({ type: 'fetch', status: 401 })
})

it('keeps strict response validation through the same native workflow', async () => {
  const { query, errors } = queryFor('validation')
  await query.refresh()
  await vi.waitFor(() => expect(errors).toHaveLength(1))
  expect(query.error.value).toMatchObject({ type: 'response-validation', issues: [expect.objectContaining({ path: 'value' })] })
})

it('clears an expected aborted read without reporting a server failure', async () => {
  let signal: AbortSignal | undefined
  const transport = vi.fn<typeof globalThis.fetch>((_request, options) => new Promise<Response>((_resolve, reject) => {
    signal = options?.signal ?? undefined
    signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
  }))
  const requestFetch = $fetch.create({ retry: 0 }, { fetch: transport })
  const scope = effectScope()
  scopes.push(scope)
  const onError = vi.fn()
  const query = scope.run(() => useNuxtRpcQuery(defineNuxtRpcQuery({
    key: 'rpc-network:expected-abort',
    path: '/api/controlled-abort',
    response: z.object({ value: z.string() }),
  }), { $fetch: requestFetch, immediate: false, refetchOnMount: false, onError }))!
  const reading = query.refresh()
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
  query.clear()
  await reading
  expect(signal?.aborted).toBe(true)
  expect(query.status.value).toBe('idle')
  expect(query.error.value).toBeUndefined()
  expect(onError).not.toHaveBeenCalled()
})
