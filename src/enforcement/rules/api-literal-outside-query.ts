import type { ContractRule } from '../types'
import { hasApiLiteral } from '../ast'

export const apiLiteralOutsideQueryRule: ContractRule = {
  code: 'api-literal-outside-query',
  applies: ctx => !ctx.isQueryFile,
  detect: ctx => hasApiLiteral(ctx.ast, ctx.options.apiPrefixes),
  message: file => `Move API path literals into an app/queries operation: ${file}`,
  terminal: true,
}
