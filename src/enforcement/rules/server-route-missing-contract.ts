import type { ContractRule } from '../types'
import { hasContractImport } from '../ast'

export const serverRouteMissingContractRule: ContractRule = {
  code: 'server-route-missing-contract',
  applies: ctx => ctx.options.requireServerContracts && ctx.isServerApiFile,
  detect: ctx => !hasContractImport(ctx.ast, ctx.options.contractDirs),
  message: file => `Server API routes must import request/response schemas from shared/contracts: ${file}`,
}
