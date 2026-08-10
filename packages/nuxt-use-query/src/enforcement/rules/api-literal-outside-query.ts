import type { ContractRule } from '../types'

export const apiLiteralOutsideQueryRule: ContractRule = {
  code: 'api-literal-outside-query',
  // Query operations own client-side API paths; server routes are policed by
  // `server-route-missing-contract` and legitimately need URL literals
  // (handler paths, upstream proxy URLs, demo fixtures returned in payloads).
  applies: ctx => !ctx.isQueryFile && !ctx.isServerApiFile,
  detect: ctx => ctx.analysis.hasApiLiteral,
  message: file => `Move API path literals into an app/queries operation: ${file}`,
  terminal: true,
}
