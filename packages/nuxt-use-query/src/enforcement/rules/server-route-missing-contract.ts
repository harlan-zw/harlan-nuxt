import type { ContractRule } from '../types'

export const serverRouteMissingContractRule: ContractRule = {
  code: 'server-route-missing-contract',
  applies: ctx => ctx.options.requireServerContracts && ctx.isServerApiFile,
  detect: ctx => ctx.analysis.hasZodUsage && !ctx.analysis.hasContractImport,
  message: file => `Server API route declares a zod schema inline; move it into shared/contracts and import it: ${file}`,
}
