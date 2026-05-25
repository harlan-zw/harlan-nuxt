import {
  createNuxtRpcClient,
  defineNuxtQueryGroup,
  defineNuxtRpcMutation,
  defineNuxtRpcQuery,
} from 'nuxt-use-query/rpc'
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'

const siteSchema = z.object({ id: z.string() })
const patchSchema = z.object({ name: z.string() })

describe('rpc type contracts', () => {
  it('infers query and mutation response output types', async () => {
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: '1' })) as any })

    const queryResult = await rpc.query(defineNuxtRpcQuery({
      key: ['sites', '1'],
      path: '/api/sites/1',
      response: siteSchema,
    }))

    expectTypeOf(queryResult).toEqualTypeOf<{ id: string }>()

    const mutationResult = await rpc.execute(defineNuxtRpcMutation({
      body: patchSchema,
      method: 'PATCH',
      path: '/api/sites/1',
      response: siteSchema,
    }), { name: 'Docs' })

    expectTypeOf(mutationResult).toEqualTypeOf<{ id: string }>()
  })

  it('requires body schema or body null for body methods', () => {
    defineNuxtRpcMutation({
      body: null,
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: siteSchema,
    })

    // @ts-expect-error POST/PATCH/PUT operations must declare body or body null.
    defineNuxtRpcMutation({
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: siteSchema,
    })
  })

  it('prevents execute body mismatch', async () => {
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: '1' })) as any })
    const patch = defineNuxtRpcMutation({
      body: patchSchema,
      method: 'PATCH',
      path: '/api/sites/1',
      response: siteSchema,
    })
    const refresh = defineNuxtRpcMutation({
      body: null,
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: siteSchema,
    })
    const remove = defineNuxtRpcMutation({
      method: 'DELETE',
      path: '/api/sites/1',
      response: siteSchema,
    })

    await rpc.execute(patch, { name: 'Docs' })
    await rpc.execute(refresh)
    await rpc.execute(remove)

    if (false) {
      // @ts-expect-error body schema mutations require a body.
      await rpc.execute(patch)
      // @ts-expect-error body null mutations reject a body argument.
      await rpc.execute(refresh, { name: 'Docs' })
      // @ts-expect-error DELETE mutations reject a body argument.
      await rpc.execute(remove, { name: 'Docs' })
    }
  })

  it('constrains query groups to operation factories', () => {
    defineNuxtQueryGroup('sites', {
      detail: (siteId: string) => defineNuxtRpcQuery({
        key: ['sites', siteId],
        path: `/api/sites/${siteId}`,
        response: siteSchema,
      }),
    })

    defineNuxtQueryGroup('bad', {
      // @ts-expect-error query groups only accept operations or operation factories.
      nope: () => ({ path: '/api/sites' }),
    })
  })
})
