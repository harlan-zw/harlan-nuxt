import {
  createNuxtRpcClient,
  defineNuxtRpcMutation,
  defineNuxtRpcQuery,
  defineNuxtRpcSchemaGroup,
} from '@harlan-zw/nuxt-use-query/rpc'
import { expectTypeOf, it } from 'vitest'
import { z } from 'zod'

it('infers inputs and outputs from a schema group', () => {
  const schemas = defineNuxtRpcSchemaGroup(async () => ({
    body: z.object({ name: z.string() }),
    response: z.object({ id: z.string() }),
  }))
  const rpc = createNuxtRpcClient({ fetch: (async () => ({})) as any })
  const query = defineNuxtRpcQuery({
    key: 'site',
    path: '/api/site',
    response: schemas('response'),
  })
  const mutation = defineNuxtRpcMutation({
    body: schemas('body'),
    method: 'PATCH',
    path: '/api/site',
    response: schemas('response'),
  })
  const _runQuery = () => rpc.query(query)
  const _runMutation = () => rpc.execute(mutation, { name: 'Site' })

  expectTypeOf<ReturnType<typeof _runQuery>>().toEqualTypeOf<Promise<{ id: string }>>()
  expectTypeOf<ReturnType<typeof _runMutation>>().toEqualTypeOf<Promise<{ id: string }>>()

  if (false) {
    // @ts-expect-error Schema group keys come from the loaded module.
    schemas('missing')
  }
})
