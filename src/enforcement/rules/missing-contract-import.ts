import type { ContractRule } from '../types'
import { findRpcOperationCalls, hasContractImport } from '../ast'

export const missingContractImportRule: ContractRule = {
  code: 'missing-contract-import',
  applies: ctx => ctx.isQueryFile,
  detect: (ctx) => {
    if (findRpcOperationCalls(ctx.ast).length === 0)
      return false
    return !hasContractImport(ctx.ast, ctx.options.contractDirs)
  },
  message: file => `Query operations must import Zod schemas from shared/contracts: ${file}`,
}
