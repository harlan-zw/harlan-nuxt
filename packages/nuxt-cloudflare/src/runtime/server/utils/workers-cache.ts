/**
 * Who owns `Cache-Control` on an HTML document.
 *
 * Workers Cache makes a headerless 200 cacheable for two hours, so a document
 * with no policy has to be given one. This module supplies that floor. What it
 * must not do is overwrite a policy the app wrote on purpose, which is what an
 * earlier version did from `render:response`: that hook receives a plain headers
 * object and no event, so it cannot see what a route rule set, and being unable
 * to check is exactly why it overwrote unconditionally.
 *
 * The floor now lives on the `request` hook and the decisions live here, at
 * `beforeResponse`, where the whole response is visible.
 *
 * Two headers, two audiences, and only one of them carries version skew:
 *
 * - `Cloudflare-CDN-Cache-Control` feeds Workers Cache, whose key includes the
 *   Worker version at `cross_version_cache: false`. A deploy makes every stored
 *   response unreachable, so a cached document can never outlive its chunks.
 * - `Cache-Control` reaches browsers, the zone cache and third-party CDNs, none
 *   of which know a deploy happened. That one needs a retention guarantee.
 */

const CACHE_POLICY_HEADER_NAMES = [
  'cache-control',
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'expires',
] as const

export const NO_STORE_BROWSER = 'private, no-store'
export const NO_STORE_EDGE = 'no-store'

/**
 * How `Cache-Control` on an HTML document is resolved.
 *
 * - `no-store` always overwrite. The behaviour before any of this existed.
 * - `auto` honour the app when a module guarantees chunk retention, clamped
 *   to what that module promises.
 * - `app` always honour the app. You own the skew risk.
 */
export type HtmlCacheMode = 'no-store' | 'auto' | 'app'

/**
 * Published by any module that can promise a document outlives its build.
 *
 * Duplicated verbatim in `nuxt-skew-protection`. Kept to a versioned,
 * field-only interface so the two copies cannot drift in behaviour, only in
 * whether they know a version. An unknown `v` is ignored rather than guessed
 * at, so a newer producer degrades to today's behaviour instead of to a wrong
 * guarantee.
 */
export interface HtmlCacheCapability {
  v: 1
  by: string
  /** Seconds a document may outlive its build and still resolve every chunk. */
  documentTtlCeilingSeconds: number
  basis: 'observed-retained-builds' | 'retention-days' | 'none'
  /** Requests for a retired build's chunks resolve instead of 404. */
  assetRecovery: boolean
}

export type HtmlCacheGuarantee
  = | { _tag: 'none', reason: 'no-capability' | 'no-asset-recovery' | 'zero-ceiling' | 'unknown-version' }
    | { _tag: 'bounded', ceilingSeconds: number, by: string }

/**
 * The weakest promise across every publisher.
 *
 * Minimum rather than maximum: a guarantee is only as good as the module least
 * able to keep it, and one publisher without asset recovery means a retired
 * chunk 404s no matter what the others retain.
 */
export function resolveHtmlCacheGuarantee(
  capabilities: unknown,
): HtmlCacheGuarantee {
  if (!Array.isArray(capabilities) || capabilities.length === 0)
    return { _tag: 'none', reason: 'no-capability' }

  const known = capabilities.filter((entry): entry is HtmlCacheCapability =>
    Boolean(entry) && typeof entry === 'object' && (entry as HtmlCacheCapability).v === 1)
  if (known.length !== capabilities.length)
    return { _tag: 'none', reason: 'unknown-version' }

  if (known.some(entry => !entry.assetRecovery))
    return { _tag: 'none', reason: 'no-asset-recovery' }

  const ceiling = Math.min(...known.map(entry => entry.documentTtlCeilingSeconds))
  if (!Number.isFinite(ceiling) || ceiling <= 0)
    return { _tag: 'none', reason: 'zero-ceiling' }

  return { _tag: 'bounded', ceilingSeconds: ceiling, by: known.map(entry => entry.by).join(', ') }
}

export function hasExplicitCachePolicy(
  getHeader: (name: string) => unknown,
): boolean {
  return CACHE_POLICY_HEADER_NAMES.some(name => Boolean(getHeader(name)))
}

function directive(value: string, name: string): number | undefined {
  const match = value.match(new RegExp(`(?:^|[,\\s])${name}=(\\d+)`, 'i'))
  return match ? Number(match[1]) : undefined
}

/**
 * Seconds a shared cache may hold this response, or null if it was refused.
 */
export function sharedCacheSeconds(cacheControl: unknown): number | null {
  const raw = Array.isArray(cacheControl) ? cacheControl.join(', ') : cacheControl
  if (typeof raw !== 'string' || !raw)
    return null
  const value = raw.toLowerCase()
  // A qualified `private="set-cookie"` names the fields a shared cache must
  // drop. It is not a refusal, and reading it as one would discard the very
  // pattern that makes a Set-Cookie response storable. Only bare `private`
  // takes the whole response out of shared caches, so the arguments are
  // removed before the check rather than matched inside it.
  const unqualified = value.replace(/=\s*"[^"]*"/g, '=""')
  if (unqualified.includes('no-store') || /(?:^|,)\s*private\s*(?:,|$)/.test(unqualified))
    return null
  const shared = directive(value, 's-maxage') ?? directive(value, 'max-age')
  if (shared === undefined || shared <= 0)
    return null
  return shared + (directive(value, 'stale-while-revalidate') ?? 0)
}

export type DocumentCacheDecision
  = | { _tag: 'floor', reason: string }
    | { _tag: 'honour' }
    | { _tag: 'clamp', toSeconds: number, fromSeconds: number, by: string }
    | { _tag: 'override', reason: string }

export interface DocumentCacheInput {
  mode: HtmlCacheMode
  guarantee: HtmlCacheGuarantee
  /** What the app set, if anything. */
  cacheControl: unknown
  status: number
  /** Any credential on the request that could personalise the document. */
  authenticated: boolean
}

/**
 * What to do with one document response.
 *
 * `floor` means nobody stated a policy, so the safe default applies and nothing
 * was taken from anyone. `override` means the app stated one and this module
 * replaced it, which is the only outcome that owes the developer a warning.
 */
export function documentCacheDecision(input: DocumentCacheInput): DocumentCacheDecision {
  const requested = sharedCacheSeconds(input.cacheControl)

  if (requested === null) {
    // Either nothing was set, or the app already said private/no-store. Both
    // end at the floor, and neither is a conflict.
    return { _tag: 'floor', reason: 'no shared-cache directive' }
  }

  // Proven properties of this response, not guesses about intent. A shared
  // cache keys on the URL, so a personalised document stored once is served to
  // everyone, and a transient error is pinned for the whole window.
  if (input.authenticated)
    return { _tag: 'override', reason: 'the request carried credentials' }
  if (input.status !== 200)
    return { _tag: 'override', reason: `the response status was ${input.status}` }

  if (input.mode === 'no-store')
    return { _tag: 'override', reason: 'workersCache.html is set to no-store' }
  if (input.mode === 'app')
    return { _tag: 'honour' }

  if (input.guarantee._tag === 'none')
    return { _tag: 'override', reason: `no module guarantees chunk retention (${input.guarantee.reason})` }

  if (requested > input.guarantee.ceilingSeconds) {
    return {
      _tag: 'clamp',
      toSeconds: input.guarantee.ceilingSeconds,
      fromSeconds: requested,
      by: input.guarantee.by,
    }
  }

  return { _tag: 'honour' }
}

/**
 * The same header with its shared-cache lifetime lowered.
 *
 * Rewrites the number and nothing else, so an app's `stale-if-error` or
 * `must-revalidate` survives a clamp. Clamping rather than replacing keeps this
 * strictly more permissive than the old behaviour, which could not regress
 * anyone on upgrade.
 */
export function clampSharedCacheSeconds(cacheControl: string, seconds: number): string {
  const replaced = cacheControl.replace(
    /(^|[,\s])(s-maxage|max-age)=(\d+)/gi,
    (whole, lead: string, name: string, value: string) =>
      Number(value) > seconds ? `${lead}${name}=${seconds}` : whole,
  )
  return /s-maxage=/i.test(replaced) ? replaced : `${replaced}, s-maxage=${seconds}`
}
