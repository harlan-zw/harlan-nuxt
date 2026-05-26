import type { ContractRule } from '../types'
import { hasContractImport, hasZodUsage } from '../ast'

export const serverRouteMissingContractRule: ContractRule = {
  code: 'server-route-missing-contract',
  applies: ctx => ctx.options.requireServerContracts && ctx.isServerApiFile,
  detect: ctx => hasZodUsage(ctx.ast) && !hasContractImport(ctx.ast, ctx.options.contractDirs),
  message: file => `Server API route declares a zod schema inline; move it into shared/contracts and import it: ${file}`,
}
