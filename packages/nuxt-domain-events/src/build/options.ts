import type { ModuleOptions } from '../types'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const FILE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']

/**
 * A layer declares a path relative to its own root. An absolute path is used as
 * given. Roots are searched in Nuxt layer order, so the app wins over a layer.
 */
export type LayerFileResult
  = { _tag: 'ok', path: string }
    | { _tag: 'err', searched: string[] }

export function resolveLayerFile(path: string, roots: readonly string[]): LayerFileResult {
  const candidates = isAbsolute(path) ? [path] : roots.map(root => resolve(root, path))
  for (const candidate of candidates) {
    const match = existingFile(candidate)
    if (match)
      return { _tag: 'ok', path: match }
  }
  return { _tag: 'err', searched: candidates }
}

/**
 * An empty array means "derive", never "no queues". An empty explicit list and
 * an omitted list express the same intent, so both derive from the host.
 */
export function resolveQueueNames(configured: string[] | undefined, derived: readonly string[]): string[] {
  return configured && configured.length > 0 ? [...configured] : [...derived]
}

export function collectSetupWarnings(options: ModuleOptions): string[] {
  const warnings: string[] = []
  if (!options.observer) {
    warnings.push('No domainEvents.observer is configured. Listener and dispatch failures reach stderr only. Set domainEvents.observer to report them.')
  }
  return warnings
}

function existingFile(candidate: string): string | undefined {
  if (existsSync(candidate) && statSync(candidate).isFile())
    return candidate
  for (const extension of FILE_EXTENSIONS) {
    const withExtension = `${candidate}${extension}`
    if (existsSync(withExtension))
      return withExtension
  }
  for (const extension of FILE_EXTENSIONS) {
    const indexFile = join(candidate, `index${extension}`)
    if (existsSync(indexFile))
      return indexFile
  }
  return undefined
}
