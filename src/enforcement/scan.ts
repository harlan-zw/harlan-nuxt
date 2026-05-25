import type {
  ContractQueryEnforcementOptions,
  ContractQueryEnforcerOptions,
  ContractQueryViolation,
  RuleContext,
} from './types'
import { normalize } from 'pathe'
import { matchesAnyDirectory, resolveContractQueryEnforcementOptions } from './options'
import { extractScriptSource, parseSourceAst } from './parse'
import { readSourceFilesFromDisk } from './read'
import { contractRules } from './rules'

export function createContractQueryEnforcer(options: ContractQueryEnforcerOptions = {}) {
  const readSourceFiles = options.readSourceFiles ?? readSourceFilesFromDisk

  return {
    async scan(rootDir: string, scanOptions: ContractQueryEnforcementOptions = {}): Promise<ContractQueryViolation[]> {
      const resolved = resolveContractQueryEnforcementOptions(scanOptions)
      const files = await readSourceFiles(rootDir, resolved)
      const violations: ContractQueryViolation[] = []

      for (const sourceFile of files) {
        const file = normalize(sourceFile.file)
        const source = extractScriptSource(sourceFile.source, file)
        if (!source.trim())
          continue

        const ast = parseSourceAst(file, source)
        const ctx: RuleContext = {
          file,
          ast,
          options: resolved,
          isQueryFile: matchesAnyDirectory(file, resolved.queryDirs),
          isServerApiFile: matchesAnyDirectory(file, resolved.serverApiDirs),
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
