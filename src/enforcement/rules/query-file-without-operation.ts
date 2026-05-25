import type { ContractRule } from '../types'
import { findRpcOperationCalls, hasApiLiteral } from '../ast'

export const queryFileWithoutOperationRule: ContractRule = {
  code: 'query-file-without-operation',
  applies: ctx => ctx.isQueryFile,
  detect: (ctx) => {
    if (!hasApiLiteral(ctx.ast, ctx.options.apiPrefixes))
      return false
    return findRpcOperationCalls(ctx.ast).length === 0
  },
  message: file => `Query files that own API paths must define Nuxt RPC operations: ${file}`,
}
