import type { ContractQueryEnforcementOptions, ResolvedContractQueryEnforcementOptions } from './types'
import { normalize } from 'pathe'

const DEFAULT_QUERY_DIRS = [
  'app/queries',
  'layers/*/app/queries',
]

const DEFAULT_CONTRACT_DIRS = [
  'shared/contracts',
  'layers/*/shared/contracts',
]

const DEFAULT_SERVER_API_DIRS = [
  'server/api',
  'layers/*/server/api',
]

/**
 * Default Nuxt code roots. Walking only these directories keeps build-time
 * config files (`nuxt.config.ts`, vite config, etc.) out of the scan; their
 * own `apiPrefixes: ['/api/']` literal would otherwise trip the rule it
 * configures.
 */
const DEFAULT_SCAN_DIRS = [
  'app',
  'server',
  'shared',
  'modules',
  'layers/*/app',
  'layers/*/server',
  'layers/*/shared',
  'apps/*/app',
  'apps/*/server',
  'apps/*/shared',
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
    ignore: options.ignore ?? DEFAULT_IGNORE,
    requireServerContracts: options.requireServerContracts ?? false,
    serverApiDirs: options.serverApiDirs ?? DEFAULT_SERVER_API_DIRS,
    scanDirs: options.scanDirs ?? DEFAULT_SCAN_DIRS,
  }
}

export function matchesAnyDirectory(file: string, patterns: string[]): boolean {
  return patterns.some(pattern => directoryPatternToRegExp(pattern).test(file))
}

export function directoryPatternToRegExp(pattern: string): RegExp {
  const normalized = normalize(pattern).replace(/^\/+|\/+$/g, '')
  const escaped = normalized
    .split('/')
    .map(part => part === '*' ? '[^/]+' : escapeRegExp(part))
    .join('/')
  return new RegExp(`(^|/)${escaped}(/|$)`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
