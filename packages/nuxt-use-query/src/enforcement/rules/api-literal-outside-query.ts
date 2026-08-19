import type { ContractRule } from '../types'

export const apiLiteralOutsideQueryRule: ContractRule = {
  code: 'api-literal-outside-query',
  // Query operations own client-side API paths. Server code is exempt: a
  // route, a middleware, and a server util all read or call internal API
  // paths by design, and `server-route-missing-contract` polices the routes.
  applies: ctx => !ctx.isQueryFile && !ctx.isServerFile,
  detect: ctx => ctx.analysis.hasApiLiteral,
  message: file => `Move API path literals into an app/queries operation: ${file}`,
  terminal: true,
}
