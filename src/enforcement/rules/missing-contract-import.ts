import type { ContractRule } from '../types'

export const missingContractImportRule: ContractRule = {
  code: 'missing-contract-import',
  applies: ctx => ctx.isQueryFile,
  detect: (ctx) => {
    if (ctx.analysis.rpcOperationCalls.length === 0)
      return false
    return !ctx.analysis.hasContractImport
  },
  message: file => `Query operations must import Zod schemas from shared/contracts: ${file}`,
}
