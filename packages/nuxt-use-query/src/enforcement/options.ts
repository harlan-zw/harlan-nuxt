import type { ContractQueryEnforcementOptions, ResolvedContractQueryEnforcementOptions } from './types'
import { normalize } from 'pathe'

// Directory patterns match anywhere in the path, so one entry also covers the
// same directory inside a layer (`layers/pro/site/app/queries`).
const DEFAULT_QUERY_DIRS = [
  'app/queries',
]

const DEFAULT_CONTRACT_DIRS = [
  'shared/contracts',
]

const DEFAULT_SERVER_API_DIRS = [
  'server/api',
]

/**
 * Default Nuxt code roots. Walking only these directories keeps build-time
 * config files (`nuxt.config.ts`, vite config, etc.) out of the scan; their
 * own `apiPrefixes: ['/api/']` literal would otherwise trip the rule it
 * configures. `**` reaches a layer at any depth, because a layer workspace
 * nests them (`layers/pro/site/app`).
 */
const DEFAULT_SCAN_DIRS = [
  'app',
  'server',
  'shared',
  'modules',
  'layers/**/app',
  'layers/**/server',
  'layers/**/shared',
  'apps/**/app',
  'apps/**/server',
  'apps/**/shared',
]

const DEFAULT_IGNORE = [
  '.git',
  '.nuxt',
  '.output',
  'coverage',
  'dist',
  'node_modules',
]

export function resolveContractQueryEnforcementOptions(options: ContractQueryEnforcementOptions = {}): ResolvedContractQueryEnforcementOptions {
  return {
    apiPrefixes: options.apiPrefixes ?? ['/api'],
    queryDirs: options.queryDirs ?? DEFAULT_QUERY_DIRS,
    contractDirs: options.contractDirs ?? DEFAULT_CONTRACT_DIRS,
    ignore: [...new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])])],
    requireServerContracts: options.requireServerContracts ?? false,
    serverApiDirs: options.serverApiDirs ?? DEFAULT_SERVER_API_DIRS,
    scanDirs: options.scanDirs ?? DEFAULT_SCAN_DIRS,
  }
}

export function matchesAnyDirectory(file: string, patterns: string[]): boolean {
  return createDirectoryMatcher(patterns)(file)
}

export function createDirectoryMatcher(patterns: string[]): (file: string) => boolean {
  const matchers = patterns.map(directoryPatternToRegExp)
  return (file: string) => matchers.some(pattern => pattern.test(file))
}

/**
 * Compile one path pattern into a matcher. Every option that names paths
 * (`queryDirs`, `contractDirs`, `serverApiDirs`, `ignore`) uses this, so they
 * all share the same semantics:
 *
 * - `*` matches one path segment, `**` matches any number of segments, `?`
 *   matches one character.
 * - The pattern matches anywhere in the path, not only at the project root. A
 *   pattern like `app/queries` therefore also covers
 *   `layers/pro/site/app/queries`, which is where a layered site keeps them.
 */
export function directoryPatternToRegExp(pattern: string): RegExp {
  return new RegExp(`(^|/)${globPatternSource(normalizePattern(pattern))}(/|$)`)
}

/** Compile one path pattern into a matcher for a single path segment. */
export function segmentPatternToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globPatternSource(normalizePattern(pattern))}$`)
}

export function normalizePattern(pattern: string): string {
  return normalize(pattern).replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

function globPatternSource(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        }
        else {
          source += '.*'
        }
      }
      else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return source
}
