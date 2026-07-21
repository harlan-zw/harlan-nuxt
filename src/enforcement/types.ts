import type { SourceAstAnalysis } from './ast'

export interface ContractQueryEnforcementOptions {
  /**
   * Fail the Nuxt build on architecture violations. Disabled by default so
   * existing consumers can adopt the contract pattern deliberately.
   */
  enabled?: boolean
  /**
   * How violations are reported. `'error'` fails the build (default);
   * `'warn'` logs them through `consola` and lets the build continue.
   */
  severity?: 'error' | 'warn'
  /** API prefixes that must be reached through query operations. */
  apiPrefixes?: string[]
  /** Files allowed to own API path literals and operation definitions. */
  queryDirs?: string[]
  /** Contract import locations expected from query files. */
  contractDirs?: string[]
  /** Server API route dirs that must also import shared contracts. */
  serverApiDirs?: string[]
  /** Require server/api route files to import from shared/contracts. */
  requireServerContracts?: boolean
  /** Extra path globs to skip. */
  ignore?: string[]
  /**
   * Directories (relative to `rootDir`) the scanner walks. Limiting the scan to
   * Nuxt app/server code roots keeps build-time config (`nuxt.config.ts`, vite
   * config, etc.) out of contract enforcement. Supports a single `*` segment
   * for layer/module fan-out (e.g. `layers/<asterisk>/app`).
   */
  scanDirs?: string[]
}

export type ContractQueryViolationCode
  = | 'api-literal-outside-query'
    | 'missing-contract-import'
    | 'mutation-body-schema-missing'
    | 'operation-response-schema-missing'
    | 'query-file-without-operation'
    | 'server-route-missing-contract'

export interface ContractQueryViolation {
  code: ContractQueryViolationCode
  file: string
  message: string
}

export interface ResolvedContractQueryEnforcementOptions {
  apiPrefixes: string[]
  queryDirs: string[]
  contractDirs: string[]
  ignore: string[]
  requireServerContracts: boolean
  serverApiDirs: string[]
  scanDirs: string[]
}

export interface ContractQuerySourceFile {
  file: string
  source: string
}

export interface ContractQueryEnforcerOptions {
  readSourceFiles?: (rootDir: string, options: ResolvedContractQueryEnforcementOptions) => Promise<ContractQuerySourceFile[]>
}

/**
 * Per-file input to a `ContractRule`. The AST is parsed once and shared across
 * every rule; `isQueryFile` / `isServerApiFile` are pre-computed directory
 * matches so each rule can guard itself without re-running glob logic.
 */
export interface RuleContext {
  analysis: SourceAstAnalysis
  file: string
  ast: any
  options: ResolvedContractQueryEnforcementOptions
  isQueryFile: boolean
  isServerApiFile: boolean
}

export interface ContractRule {
  code: ContractQueryViolationCode
  /** Quick gate; returning false skips `detect` entirely. */
  applies: (ctx: RuleContext) => boolean
  /** True when the rule's pattern is present in this file. */
  detect: (ctx: RuleContext) => boolean
  message: (file: string) => string
  /**
   * When true, firing this rule stops further rules for the same file. Used by
   * `api-literal-outside-query` to mirror the previous early-`continue`
   * behaviour (a non-query file with an API literal is fully described by that
   * one violation; remaining query-file rules don't apply anyway).
   */
  terminal?: boolean
}
