import type { Static404FallbackOptions } from './runtime/server/utils/static-404-fallback'
import {
  DEFAULT_STATIC_404_ASSET_PATH,
  resolveStatic404FallbackPolicy,
} from './runtime/server/utils/static-404-fallback.ts'

export interface Static404FallbackConfigInput {
  /** Module option `nuxtCloudflare.static404Fallback`. */
  static404Fallback?: boolean | Static404FallbackOptions
  /** Nuxt `future.compatibilityVersion` (defaults to `4`). */
  compatibilityVersion?: number
  /** Nuxt `experimental.inlineErrorRendering`. */
  inlineErrorRendering?: boolean
  /** Nuxt `experimental.prerenderErrorPages`. */
  prerenderErrorPages?: boolean | readonly number[]
  /** Configured Nitro prerender routes (`nitro.prerender.routes`). */
  prerenderRoutes?: readonly string[]
  /** Configured Nitro route rules (`nitro.routeRules`). */
  routeRules?: Readonly<Record<string, unknown>>
  /** Whether Nitro builds a static site (`nitro.static`). */
  staticPreset?: boolean
}

export type Static404FallbackWarning
  = | {
    _tag: 'inline-error-rendering'
    source: 'explicit' | 'compatibility-version'
  }
  | {
    _tag: 'prerender-error-pages-disabled'
    assetPath: string
    prerenderRouteConfigured: boolean
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function prerenderErrorPagesIncludes404(value: boolean | readonly number[] | undefined): boolean {
  return value === true || (Array.isArray(value) && value.includes(404))
}

function hasPrerenderRoute(assetPath: string, input: Static404FallbackConfigInput): boolean {
  if (input.staticPreset === true && assetPath === DEFAULT_STATIC_404_ASSET_PATH)
    return true

  if (input.prerenderRoutes?.some(route => route.trim() === assetPath))
    return true

  const rule = input.routeRules?.[assetPath]
  return isRecord(rule) && rule.prerender === true
}

export function findStatic404FallbackWarnings(
  input: Static404FallbackConfigInput,
): Static404FallbackWarning[] {
  const policy = resolveStatic404FallbackPolicy(input.static404Fallback)
  if (policy._tag === 'disabled')
    return []

  const warnings: Static404FallbackWarning[] = []
  if (input.inlineErrorRendering === true) {
    warnings.push({
      _tag: 'inline-error-rendering',
      source: 'explicit',
    })
  }
  else if (input.inlineErrorRendering !== false && (input.compatibilityVersion ?? 4) >= 5) {
    warnings.push({
      _tag: 'inline-error-rendering',
      source: 'compatibility-version',
    })
  }

  if (policy.assetPath === DEFAULT_STATIC_404_ASSET_PATH && !prerenderErrorPagesIncludes404(input.prerenderErrorPages)) {
    warnings.push({
      _tag: 'prerender-error-pages-disabled',
      assetPath: policy.assetPath,
      prerenderRouteConfigured: hasPrerenderRoute(policy.assetPath, input),
    })
  }

  return warnings
}

export function formatStatic404FallbackWarnings(
  warnings: readonly Static404FallbackWarning[],
): string {
  return warnings
    .map((warning) => {
      if (warning._tag === 'inline-error-rendering') {
        if (warning.source === 'compatibility-version') {
          return '`static404Fallback` cannot intercept 404 renders because `future.compatibilityVersion >= 5` enables `experimental.inlineErrorRendering` by default. Set `experimental.inlineErrorRendering: false` in `nuxt.config.ts`.'
        }
        return '`static404Fallback` cannot intercept 404 renders while `experimental.inlineErrorRendering` is enabled. Set `experimental.inlineErrorRendering: false` in `nuxt.config.ts`.'
      }

      if (warning.prerenderRouteConfigured) {
        return `\`${warning.assetPath}\` prerenders as an empty SPA shell while \`experimental.prerenderErrorPages\` excludes 404. Set \`experimental.prerenderErrorPages: true\` in \`nuxt.config.ts\`.`
      }
      return `\`${warning.assetPath}\` prerenders as an empty SPA shell while \`experimental.prerenderErrorPages\` excludes 404. Set \`experimental.prerenderErrorPages: true\` and add \`'${warning.assetPath}'\` to \`nitro.prerender.routes\` in \`nuxt.config.ts\`.`
    })
    .join('\n')
}
