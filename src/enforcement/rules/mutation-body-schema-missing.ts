import type { ContractRule } from '../types'
import { findRpcOperationCalls, getLiteralString, getObjectProperties } from '../ast'

const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT'])

export const mutationBodySchemaMissingRule: ContractRule = {
  code: 'mutation-body-schema-missing',
  applies: ctx => ctx.isQueryFile,
  detect: (ctx) => {
    for (const call of findRpcOperationCalls(ctx.ast)) {
      if (call.calleeName !== 'defineNuxtRpcMutation')
        continue
      if (call.argument?.type !== 'ObjectExpression')
        continue
      const props = getObjectProperties(call.argument)
      const method = getLiteralString(props.get('method')?.value)
      if (method != null && BODY_METHODS.has(method) && !props.has('body'))
        return true
    }
    return false
  },
  message: file => `POST/PATCH/PUT mutations must declare body: schema or body: null: ${file}`,
}
