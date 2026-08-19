import type {
  ContractQueryEnforcementOptions,
  ContractQueryEnforcerOptions,
  ContractQueryViolation,
  RuleContext,
} from './types'
import { normalize } from 'pathe'
import { createSourceAstAnalyzer } from './ast'
import { createDirectoryMatcher, resolveContractQueryEnforcementOptions } from './options'
import { extractScriptSource, parseSourceAst } from './parse'
import { readSourceFilesFromDisk } from './read'
import { contractRules } from './rules'

/**
 * Server code is exempt from the client-side API literal rule. A route
 * handler, a middleware, and a server util all read or call internal API
 * paths by design.
 */
const SERVER_DIRS = ['server']

export function createContractQueryEnforcer(options: ContractQueryEnforcerOptions = {}) {
  const readSourceFiles = options.readSourceFiles ?? readSourceFilesFromDisk

  return {
    async scan(rootDir: string, scanOptions: ContractQueryEnforcementOptions = {}): Promise<ContractQueryViolation[]> {
      const resolved = resolveContractQueryEnforcementOptions(scanOptions)
      const files = await readSourceFiles(rootDir, resolved)
      const violations: ContractQueryViolation[] = []
      const analyzeAst = createSourceAstAnalyzer(resolved.apiPrefixes, resolved.contractDirs)
      const isQueryFile = createDirectoryMatcher(resolved.queryDirs)
      const isServerApiFile = createDirectoryMatcher(resolved.serverApiDirs)
      const isServerFile = createDirectoryMatcher(SERVER_DIRS)

      for (const sourceFile of files) {
        const file = normalize(sourceFile.file)
        const source = extractScriptSource(sourceFile.source, file)
        if (!source.trim())
          continue

        const ast = parseSourceAst(file, source)
        const queryFile = isQueryFile(file)
        const ctx: RuleContext = {
          analysis: analyzeAst(ast, { isQueryFile: queryFile }),
          file,
          ast,
          options: resolved,
          isQueryFile: queryFile,
          isServerApiFile: isServerApiFile(file),
          isServerFile: isServerFile(file),
        }

        runRulesForFile(ctx, violations)
      }

      return violations
    },
  }
}

export async function scanContractQueryViolations(rootDir: string, options: ContractQueryEnforcementOptions = {}): Promise<ContractQueryViolation[]> {
  return createContractQueryEnforcer().scan(rootDir, options)
}

export function formatContractQueryViolations(violations: ContractQueryViolation[]): string {
  const lines = violations.map(violation => `- [${violation.code}] ${violation.message}`)
  return [
    'nuxt-use-query contract enforcement failed:',
    ...lines,
  ].join('\n')
}

/**
 * Runs every rule against a single file. Mirrors the previous `analyzeSource`
 * + emission loop one-for-one: `api-literal-outside-query` short-circuits the
 * remaining rules for that file (preserves caller-observed violation order).
 */
function runRulesForFile(ctx: RuleContext, violations: ContractQueryViolation[]): void {
  for (const rule of contractRules) {
    if (!rule.applies(ctx))
      continue
    if (!rule.detect(ctx))
      continue
    violations.push({
      code: rule.code,
      file: ctx.file,
      message: rule.message(ctx.file),
    })
    if (rule.terminal)
      return
  }
}
