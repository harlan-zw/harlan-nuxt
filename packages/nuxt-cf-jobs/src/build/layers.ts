import type { Nuxt } from '@nuxt/schema'
import { resolve } from 'node:path'

/** The shape `nuxt.options._layers` exposes that identifies a layer's root. */
interface LayerLike {
  cwd?: string
  config?: { rootDir?: string }
}

/**
 * Resolve a directory option that accepts `true` (auto-discover), `false`
 * (disabled), or explicit path(s).
 *
 * `true` resolves `subDir` in the app root AND in every extended layer
 * (`nuxt.options._layers`), so adding a layer needs no host config change.
 * Explicit paths are returned unchanged; callers resolve them from `rootDir`.
 */
export function resolveLayeredDirs(
  input: string | string[] | boolean | undefined,
  nuxt: Nuxt,
  subDir: string,
  fallback?: string,
): string[] {
  if (input === false)
    return []
  if (input === undefined)
    return fallback === undefined ? [] : [fallback]
  if (input !== true)
    return Array.isArray(input) ? input : [input]

  const layers = (nuxt.options as unknown as { _layers?: ReadonlyArray<LayerLike> })._layers ?? []
  const dirs = [
    resolve(nuxt.options.rootDir, subDir),
    ...layers
      .map(layer => layer.cwd ?? layer.config?.rootDir)
      .filter((cwd): cwd is string => !!cwd)
      .map(cwd => resolve(cwd, subDir)),
  ]
  return [...new Set(dirs)]
}
