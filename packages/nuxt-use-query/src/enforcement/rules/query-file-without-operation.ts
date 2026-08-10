import type { ContractRule } from '../types'

export const queryFileWithoutOperationRule: ContractRule = {
  code: 'query-file-without-operation',
  applies: ctx => ctx.isQueryFile,
  detect: (ctx) => {
    if (!ctx.analysis.hasApiLiteral)
      return false
    return ctx.analysis.rpcOperationCalls.length === 0
  },
  message: file => `Query files that own API paths must define Nuxt RPC operations: ${file}`,
}
