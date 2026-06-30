import type { ContractRule, RuleContext } from '../src/enforcement'
import { describe, expect, it } from 'vitest'
import {
  apiLiteralOutsideQueryRule,
  matchesAnyDirectory,
  missingContractImportRule,
  mutationBodySchemaMissingRule,
  operationResponseSchemaMissingRule,
  queryFileWithoutOperationRule,
  resolveContractQueryEnforcementOptions,
  serverRouteMissingContractRule,
} from '../src/enforcement'
import { parseSourceAst } from '../src/enforcement/parse'

// Per-rule tests. Each rule is exercised against a tiny source string — this
// is the test-surface gain from splitting `analyzeSource` into the registry.

function makeCtx(file: string, source: string, overrides: Partial<RuleContext['options']> = {}): RuleContext {
  const options = resolveContractQueryEnforcementOptions(overrides)
  return {
    file,
    ast: parseSourceAst(file, source),
    options,
    isQueryFile: matchesAnyDirectory(file, options.queryDirs),
    isServerApiFile: matchesAnyDirectory(file, options.serverApiDirs),
  }
}

function runRule(rule: ContractRule, ctx: RuleContext): boolean {
  if (!rule.applies(ctx))
    return false
  return rule.detect(ctx)
}

describe('apiLiteralOutsideQueryRule', () => {
  it('fires on string-literal api paths outside query dirs', () => {
    const ctx = makeCtx('app/components/Foo.ts', 'const x = $fetch("/api/sites")')
    expect(runRule(apiLiteralOutsideQueryRule, ctx)).toBe(true)
    expect(apiLiteralOutsideQueryRule.terminal).toBe(true)
  })

  it('fires on template-literal api paths', () => {
    // eslint-disable-next-line no-template-curly-in-string -- intentional template-literal sample for AST detection
    const ctx = makeCtx('app/components/Foo.ts', 'const x = $fetch(`/api/sites/${id}`)')
    expect(runRule(apiLiteralOutsideQueryRule, ctx)).toBe(true)
  })

  it('skips query files', () => {
    const ctx = makeCtx('app/queries/sites.ts', 'const x = "/api/sites"')
    expect(runRule(apiLiteralOutsideQueryRule, ctx)).toBe(false)
  })

  it('respects custom api prefixes', () => {
    const ctx = makeCtx(
      'app/components/Foo.ts',
      'const x = "/api/public/sites"',
      { apiPrefixes: ['/api/private'] },
    )
    expect(runRule(apiLiteralOutsideQueryRule, ctx)).toBe(false)
  })

  it('normalizes trailing slashes in custom api prefixes', () => {
    const ctx = makeCtx(
      'app/components/Foo.ts',
      'const x = "/api/sites"',
      { apiPrefixes: ['/api/'] },
    )
    expect(runRule(apiLiteralOutsideQueryRule, ctx)).toBe(true)
  })
})

describe('queryFileWithoutOperationRule', () => {
  it('fires when a query file has API paths but no define call', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'export const sites = { detail: () => ({ path: "/api/sites/1" }) }',
    )
    expect(runRule(queryFileWithoutOperationRule, ctx)).toBe(true)
  })

  it('skips query files with a define call', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'export const sites = defineNuxtRpcQuery({ key: "x", path: "/api/sites", response: s })',
    )
    expect(runRule(queryFileWithoutOperationRule, ctx)).toBe(false)
  })

  it('skips non-query files', () => {
    const ctx = makeCtx('app/components/Foo.ts', 'const x = "/api/sites"')
    expect(runRule(queryFileWithoutOperationRule, ctx)).toBe(false)
  })
})

describe('missingContractImportRule', () => {
  it('fires when an operation is defined without a shared/contracts import', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'export const s = defineNuxtRpcQuery({ key: "s", path: "/api/s", response: x })',
    )
    expect(runRule(missingContractImportRule, ctx)).toBe(true)
  })

  it('skips when shared/contracts is imported', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'import { x } from "@/shared/contracts/site"; export const s = defineNuxtRpcQuery({ key: "s", path: "/api/s", response: x })',
    )
    expect(runRule(missingContractImportRule, ctx)).toBe(false)
  })

  it('skips files without any operation call', () => {
    const ctx = makeCtx('app/queries/sites.ts', 'export const s = 1')
    expect(runRule(missingContractImportRule, ctx)).toBe(false)
  })
})

describe('operationResponseSchemaMissingRule', () => {
  it('fires when an operation omits response', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'export const s = defineNuxtRpcQuery({ key: "s", path: "/api/s" })',
    )
    expect(runRule(operationResponseSchemaMissingRule, ctx)).toBe(true)
  })

  it('skips defineNuxtQueryGroup calls', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'export const g = defineNuxtQueryGroup("sites", {})',
    )
    expect(runRule(operationResponseSchemaMissingRule, ctx)).toBe(false)
  })

  it('checks direct operation objects inside defineNuxtQueryGroup', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'export const g = defineNuxtQueryGroup("sites", { detail: { key: "s", path: "/api/s" } })',
    )
    expect(runRule(operationResponseSchemaMissingRule, ctx)).toBe(true)
  })

  it('skips when response is present', () => {
    const ctx = makeCtx(
      'app/queries/sites.ts',
      'export const s = defineNuxtRpcQuery({ key: "s", path: "/api/s", response: x })',
    )
    expect(runRule(operationResponseSchemaMissingRule, ctx)).toBe(false)
  })
})

describe('mutationBodySchemaMissingRule', () => {
  it('fires on POST/PATCH/PUT without body', () => {
    for (const method of ['POST', 'PATCH', 'PUT']) {
      const ctx = makeCtx(
        'app/queries/update.ts',
        `export const m = defineNuxtRpcMutation({ method: "${method}", path: "/api/x", response: r })`,
      )
      expect(runRule(mutationBodySchemaMissingRule, ctx)).toBe(true)
    }
  })

  it('skips DELETE (bodyless method)', () => {
    const ctx = makeCtx(
      'app/queries/update.ts',
      'export const m = defineNuxtRpcMutation({ method: "DELETE", path: "/api/x", response: r })',
    )
    expect(runRule(mutationBodySchemaMissingRule, ctx)).toBe(false)
  })

  it('skips when body is declared', () => {
    const ctx = makeCtx(
      'app/queries/update.ts',
      'export const m = defineNuxtRpcMutation({ method: "POST", path: "/api/x", body: b, response: r })',
    )
    expect(runRule(mutationBodySchemaMissingRule, ctx)).toBe(false)
  })

  it('checks direct mutation objects inside defineNuxtQueryGroup', () => {
    const ctx = makeCtx(
      'app/queries/update.ts',
      'export const g = defineNuxtQueryGroup("sites", { update: { method: "PATCH", path: "/api/x", response: r } })',
    )
    expect(runRule(mutationBodySchemaMissingRule, ctx)).toBe(true)
  })
})

describe('serverRouteMissingContractRule', () => {
  it('fires on server/api files that declare a zod schema inline', () => {
    const ctx = makeCtx(
      'server/api/sites.get.ts',
      'import { z } from "zod"; const body = z.object({ id: z.string() }); export default defineEventHandler(() => ({ ok: true }))',
      { requireServerContracts: true },
    )
    expect(runRule(serverRouteMissingContractRule, ctx)).toBe(true)
  })

  it('skips server/api files with no zod usage', () => {
    const ctx = makeCtx(
      'server/api/sites.get.ts',
      'export default defineEventHandler(() => ({ ok: true }))',
      { requireServerContracts: true },
    )
    expect(runRule(serverRouteMissingContractRule, ctx)).toBe(false)
  })

  it('skips server/api files that only import zod error helpers', () => {
    const ctx = makeCtx(
      'server/api/sites.get.ts',
      'import { ZodError } from "zod"; export default defineEventHandler(() => ZodError)',
      { requireServerContracts: true },
    )
    expect(runRule(serverRouteMissingContractRule, ctx)).toBe(false)
  })

  it('detects inline schemas from aliased zod namespace imports', () => {
    const ctx = makeCtx(
      'server/api/sites.get.ts',
      'import { z as zod } from "zod"; const body = zod.object({ id: zod.string() }); export default defineEventHandler(() => ({ ok: true }))',
      { requireServerContracts: true },
    )
    expect(runRule(serverRouteMissingContractRule, ctx)).toBe(true)
  })

  it('skips when requireServerContracts is false', () => {
    const ctx = makeCtx(
      'server/api/sites.get.ts',
      'export default defineEventHandler(() => ({ ok: true }))',
    )
    expect(runRule(serverRouteMissingContractRule, ctx)).toBe(false)
  })

  it('skips server/api files that do import shared/contracts', () => {
    const ctx = makeCtx(
      'server/api/sites.get.ts',
      'import { siteSchema } from "@/shared/contracts/site"; export default defineEventHandler(() => ({ ok: true }))',
      { requireServerContracts: true },
    )
    expect(runRule(serverRouteMissingContractRule, ctx)).toBe(false)
  })

  it('skips non-server-api files', () => {
    const ctx = makeCtx(
      'app/components/Foo.ts',
      'export default {}',
      { requireServerContracts: true },
    )
    expect(runRule(serverRouteMissingContractRule, ctx)).toBe(false)
  })
})
