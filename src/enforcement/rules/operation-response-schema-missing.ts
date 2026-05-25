import type { ContractRule } from '../types'
import { findRpcOperationCalls, getObjectProperties } from '../ast'

export const operationResponseSchemaMissingRule: ContractRule = {
  code: 'operation-response-schema-missing',
  applies: ctx => ctx.isQueryFile,
  detect: (ctx) => {
    for (const call of findRpcOperationCalls(ctx.ast)) {
      if (call.calleeName === 'defineNuxtQueryGroup')
        continue
      if (call.argument?.type !== 'ObjectExpression')
        continue
      const props = getObjectProperties(call.argument)
      if (!props.has('response'))
        return true
    }
    return false
  },
  message: file => `Nuxt RPC operations must declare response: schema: ${file}`,
}
