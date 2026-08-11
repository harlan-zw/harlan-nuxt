import type { WranglerDiagnostic, WranglerDiagnosticCode } from './wrangler'
import { existsSync } from 'node:fs'
import { dirname, extname, resolve } from 'pathe'
import { WRANGLER_DIAGNOSTIC_CODES } from './wrangler'

export type WranglerDiagnosticPolicy
  = | { _tag: 'advisory' }
    | { _tag: 'strict', allowedWarnings?: readonly WranglerDiagnosticCode[] }

export type WranglerDoctorOutcome
  = | {
    _tag: 'passed'
    blockingDiagnostics: readonly []
    diagnostics: readonly WranglerDiagnostic[]
    schemaVersion: 1
  }
  | {
    _tag: 'failed'
    blockingDiagnostics: readonly WranglerDiagnostic[]
    diagnostics: readonly WranglerDiagnostic[]
    reason: 'errors' | 'strict-warnings'
    schemaVersion: 1
  }

const WRANGLER_SOURCE_CONFIG_NAMES = [
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
] as const

export function discoverWranglerSourceConfigs(cwd: string, explicitConfig?: string): string[] {
  if (explicitConfig) {
    const path = resolve(cwd, explicitConfig)
    return existsSync(path) ? [path] : []
  }
  let directory = resolve(cwd)
  while (true) {
    const paths = WRANGLER_SOURCE_CONFIG_NAMES
      .map(name => resolve(directory, name))
      .filter(path => existsSync(path))
    if (paths.length > 0)
      return paths
    const parent = dirname(directory)
    if (parent === directory)
      return []
    directory = parent
  }
}

export function diagnoseWranglerSourceConfigs(paths: readonly string[]): WranglerDiagnostic[] {
  const diagnostics = paths.flatMap((path): WranglerDiagnostic[] => extname(path) === '.toml'
    ? [{
        _tag: 'info',
        code: 'wrangler-jsonc-preferred',
        message: 'Cloudflare recommends wrangler.jsonc for new projects; TOML remains supported.',
        sourcePath: path,
      }]
    : [])
  if (paths.length > 1) {
    diagnostics.push({
      _tag: 'warning',
      code: 'wrangler-config-shadowed',
      message: 'Multiple root Wrangler configs exist. Keep one wrangler.jsonc source of truth to prevent silent precedence drift.',
      sourcePath: paths[0]!,
    })
  }
  return diagnostics
}

export function isWranglerDiagnosticBlocking(
  diagnostic: WranglerDiagnostic,
  policy: WranglerDiagnosticPolicy,
): boolean {
  if (diagnostic._tag === 'error')
    return true
  return diagnostic._tag === 'warning'
    && policy._tag === 'strict'
    && !new Set(policy.allowedWarnings ?? []).has(diagnostic.code)
}

export function parseWranglerAllowedWarnings(value: string | undefined): WranglerDiagnosticCode[] {
  if (!value)
    return []
  const knownCodes = new Set<string>(WRANGLER_DIAGNOSTIC_CODES)
  return value.split(',').map(part => part.trim()).filter(Boolean).map((code) => {
    if (!knownCodes.has(code))
      throw new TypeError(`Unknown Wrangler diagnostic code: ${code}`)
    return code as WranglerDiagnosticCode
  })
}

export function evaluateWranglerDiagnostics(
  diagnostics: readonly WranglerDiagnostic[],
  policy: WranglerDiagnosticPolicy,
): WranglerDoctorOutcome {
  const blockingDiagnostics = diagnostics.filter(diagnostic => isWranglerDiagnosticBlocking(diagnostic, policy))
  if (blockingDiagnostics.length === 0) {
    return {
      _tag: 'passed',
      blockingDiagnostics: [],
      diagnostics,
      schemaVersion: 1,
    }
  }
  return {
    _tag: 'failed',
    blockingDiagnostics,
    diagnostics,
    reason: blockingDiagnostics.some(diagnostic => diagnostic._tag === 'error')
      ? 'errors'
      : 'strict-warnings',
    schemaVersion: 1,
  }
}
