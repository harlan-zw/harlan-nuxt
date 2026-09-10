import type { WranglerDiagnostic } from './wrangler'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'pathe'

/**
 * Cloudflare's published caps for the static asset control files. The upload
 * rejects a file past them, which fails the whole deploy minutes after the
 * build said it was fine.
 */
export const STATIC_ASSET_RULE_LIMITS = {
  headers: 100,
  redirectsStatic: 2000,
  redirectsDynamic: 100,
} as const

export interface StaticAssetRuleFiles {
  headers?: string
  redirects?: string
}

/**
 * The `_headers` and `_redirects` files an output carries, when present.
 *
 * Nitro's Workers presets write them under the public directory. The Pages
 * presets write them at the output root, so the caller passes every place a
 * preset can put them and the first directory holding a file wins.
 */
export function readStaticAssetRuleFiles(directories: readonly string[]): StaticAssetRuleFiles {
  const files: StaticAssetRuleFiles = {}
  for (const [key, name] of [['headers', '_headers'], ['redirects', '_redirects']] as const) {
    for (const directory of directories) {
      const path = join(directory, name)
      if (existsSync(path)) {
        files[key] = readFileSync(path, 'utf8')
        break
      }
    }
  }
  return files
}

/** Rule lines: everything that is not blank, a comment, or an indented header line. */
function ruleLines(contents: string): string[] {
  return contents.split(/\r?\n/).filter(line => /^[^\s#]/.test(line))
}

/** `/guide/foo/bar` becomes `/guide/*`, so the count points at the module or route group that owns it. */
function rulePrefix(route: string): string {
  const segments = route.split('/').filter(Boolean)
  return segments.length > 1 ? `/${segments[0]}/*` : route
}

function topPrefixes(routes: readonly string[], limit = 3): string {
  const counts = new Map<string, number>()
  for (const route of routes)
    counts.set(rulePrefix(route), (counts.get(rulePrefix(route)) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([prefix, count]) => `${prefix} (${count})`)
    .join(', ')
}

function isDynamicRedirect(source: string): boolean {
  return source.includes('*') || source.includes(':')
}

/**
 * Errors for a `_headers` or `_redirects` file Cloudflare would refuse. The
 * message names the path prefixes holding the most rules, because the file is
 * assembled from every module's route rules and the reader needs to know
 * which one to trim.
 */
export function diagnoseStaticAssetRules(files: StaticAssetRuleFiles): WranglerDiagnostic[] {
  const diagnostics: WranglerDiagnostic[] = []
  if (files.headers !== undefined) {
    const routes = ruleLines(files.headers).map(line => line.trim())
    if (routes.length > STATIC_ASSET_RULE_LIMITS.headers) {
      diagnostics.push({
        _tag: 'error',
        code: 'static-headers-rule-limit',
        message: `_headers has ${routes.length} rules and Cloudflare accepts ${STATIC_ASSET_RULE_LIMITS.headers}. The upload fails past that. Most rules sit under: ${topPrefixes(routes)}. Collapse them into globs or stop the module that emits them.`,
        sourcePath: '_headers',
      })
    }
  }
  if (files.redirects !== undefined) {
    const sources = ruleLines(files.redirects).map(line => line.trim().split(/\s+/)[0]!)
    const dynamic = sources.filter(isDynamicRedirect)
    const staticCount = sources.length - dynamic.length
    const overStatic = staticCount > STATIC_ASSET_RULE_LIMITS.redirectsStatic
    const overDynamic = dynamic.length > STATIC_ASSET_RULE_LIMITS.redirectsDynamic
    if (overStatic || overDynamic) {
      diagnostics.push({
        _tag: 'error',
        code: 'static-redirects-rule-limit',
        message: `_redirects has ${staticCount} static and ${dynamic.length} dynamic rules and Cloudflare accepts ${STATIC_ASSET_RULE_LIMITS.redirectsStatic} static and ${STATIC_ASSET_RULE_LIMITS.redirectsDynamic} dynamic. The upload fails past that. Most rules sit under: ${topPrefixes(sources)}.`,
        sourcePath: '_redirects',
      })
    }
  }
  return diagnostics
}
