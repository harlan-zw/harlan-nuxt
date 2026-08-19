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
function parseCapability(entry: unknown): HtmlCacheCapability | null {
  if (!entry || typeof entry !== 'object')
    return null
  const candidate = entry as Record<string, unknown>
  if (candidate.v !== 1)
    return null
  // Every field checked, not just the version. This value crosses a package
  // boundary and decides whether a document is published to a shared cache, so
  // a string, an array or a boolean in the ceiling must not be coerced into a
  // number by `Math.min`. Parse it once here and trust it afterwards.
  if (typeof candidate.documentTtlCeilingSeconds !== 'number')
    return null
  if (!Number.isInteger(candidate.documentTtlCeilingSeconds) || candidate.documentTtlCeilingSeconds <= 0)
    return null
  if (typeof candidate.assetRecovery !== 'boolean')
    return null
  if (typeof candidate.by !== 'string' || !candidate.by)
    return null
  if (candidate.basis !== 'observed-retained-builds' && candidate.basis !== 'retention-days')
    return null
  return {
    v: 1,
    by: candidate.by,
    documentTtlCeilingSeconds: candidate.documentTtlCeilingSeconds,
    basis: candidate.basis,
    assetRecovery: candidate.assetRecovery,
  }
}

/**
 * The weakest promise across every publisher.
 *
 * Minimum rather than maximum: a guarantee is only as good as the module least
 * able to keep it, and one publisher without asset recovery means a retired
 * chunk 404s whatever the others retain.
 */
export function resolveHtmlCacheGuarantee(
  capabilities: unknown,
): HtmlCacheGuarantee {
  if (!Array.isArray(capabilities) || capabilities.length === 0)
    return { _tag: 'none', reason: 'no-capability' }

  const known = capabilities.map(parseCapability)
  if (known.includes(null))
    return { _tag: 'none', reason: 'unknown-version' }

  const parsed = known as HtmlCacheCapability[]
  // Checked after parsing, not during, so a well-formed publisher that simply
  // cannot recover assets is reported as such rather than as malformed.
  if (parsed.some(entry => !entry.assetRecovery))
    return { _tag: 'none', reason: 'no-asset-recovery' }

  const ceiling = Math.min(...parsed.map(entry => entry.documentTtlCeilingSeconds))
  if (!Number.isFinite(ceiling) || ceiling <= 0)
    return { _tag: 'none', reason: 'zero-ceiling' }

  return { _tag: 'bounded', ceilingSeconds: ceiling, by: parsed.map(entry => entry.by).join(', ') }
}

function directive(value: string, name: string): number | undefined {
  // `\s*` around `=` because RFC 9110 allows optional whitespace there, and a
  // header written by hand often has it.
  const match = value.match(new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(\\d+)`, 'gi'))
  if (!match)
    return undefined
  // Most restrictive wins. A duplicated directive is malformed, and reading the
  // first one makes the answer depend on the order it was written in.
  return Math.min(...match.map(part => Number(part.replace(/\D+/g, ''))))
}

/** A year. Longer than any retention window, and past this the number is noise. */
const MAX_SANE_SECONDS = 31_536_000

/**
 * The header with every quoted argument emptied.
 *
 * `private="set-cookie"` names the fields a shared cache must drop; it is not a
 * refusal. Emptying the arguments means neither the refusal test nor the
 * lifetime test can read anything out of them, so a header like
 * `private="x, s-maxage=99999"` cannot smuggle a lifetime past either.
 */
function unqualify(value: string): string {
  return value.replace(/=\s*"[^"]*"/g, '=""')
}

/**
 * Seconds a shared cache may serve this response, or null if it was refused.
 *
 * Counts the stale window, because a stale response is still served. `no-cache`
 * counts as a refusal: it permits storage but forbids reuse without
 * revalidation, which is not what "the app asked for shared caching" means.
 */
export function sharedCacheSeconds(cacheControl: unknown): number | null {
  const raw = Array.isArray(cacheControl) ? cacheControl.join(', ') : cacheControl
  if (typeof raw !== 'string' || !raw)
    return null
  const value = unqualify(raw.toLowerCase())

  if (/(?:^|,)\s*no-store\s*(?:,|$)/.test(value))
    return null
  if (/(?:^|,)\s*no-cache\s*(?:,|$)/.test(value))
    return null
  if (/(?:^|,)\s*private\s*(?:,|$)/.test(value))
    return null

  const shared = directive(value, 's-maxage') ?? directive(value, 'max-age')
  if (shared === undefined || shared <= 0)
    return null

  return Math.min(shared + (directive(value, 'stale-while-revalidate') ?? 0), MAX_SANE_SECONDS)
}

/** Whether the app stated any cache policy at all, however restrictive. */
export function statedPolicy(
  getHeader: (name: string) => unknown,
): boolean {
  return CACHE_POLICY_HEADER_NAMES.some(name => Boolean(getHeader(name)))
}

export type CacheDecision
  = | { _tag: 'leave' }
    | { _tag: 'floor' }
    | { _tag: 'clamp', toSeconds: number, fromSeconds: number, by: string }
    | { _tag: 'override', reason: string }

export interface CacheDecisionInput {
  mode: HtmlCacheMode
  guarantee: HtmlCacheGuarantee
  /** True only for a rendered HTML document, from the response content type. */
  isDocument: boolean
  /** Whether the app set any cache header at all. */
  stated: boolean
  /** The lifetime the app asked a shared cache for, if any. */
  requestedSeconds: number | null
  status: number
  /** A credential on the request that could personalise the response. */
  authenticated: boolean
  /** The response mints a cookie, so it carries state a shared copy must not. */
  setsCookie: boolean
  /** The response's own `Vary`, if it set one. */
  vary: string | undefined
}

/**
 * Whether a `Vary` can be satisfied by a cache keyed on the URL.
 *
 * A shared cache does not key on `Cookie` or `Authorization`, so a response
 * asking it to vary on either is asking for something it cannot do, and storing
 * it anyway serves one person's copy to everyone. `*` means never store.
 *
 * This module deliberately does not invent a `Vary` where the app set none.
 * Injecting `Accept` or `Accept-Language` would collapse the hit rate for every
 * route that does not negotiate, and would hide the app's own bug on the ones
 * that do. The route rule asking for shared caching is the app's assertion that
 * the route does not vary, and the build log says so out loud.
 */
export function varyIsSatisfiable(vary: string | undefined): boolean {
  if (!vary)
    return true
  const fields = vary.toLowerCase().split(',').map(field => field.trim())
  if (fields.includes('*'))
    return false
  return !fields.includes('cookie') && !fields.includes('authorization')
}

/**
 * Statuses whose cache headers must never be rewritten.
 *
 * A 304 carries no body and its headers *update* the stored response (RFC 9111
 * 4.3.4), so forcing `no-store` onto one evicts the entry it just validated.
 * Permanent redirects are ordinarily cacheable and say nothing about a user.
 */
const PRESERVED_STATUSES = new Set([301, 304, 308])

/**
 * What to do with one response.
 *
 * Only rendered documents are subject to the version-skew policy, because only
 * a document names build chunks. Everything else, assets, API payloads,
 * sitemaps, is the app's business and is left exactly as the app wrote it. An
 * earlier revision of this applied the document rules to every response and
 * rewrote nitro's own `/_nuxt/**` immutable rule to `private, no-store`.
 *
 * `leave` means untouched. `floor` means nobody stated a policy, so the safe
 * default applies and nothing was taken. `override` means the app stated one
 * and this module replaced it, which is the only outcome that owes a warning.
 */
export function responseCacheDecision(input: CacheDecisionInput): CacheDecision {
  // Workers Cache treats a headerless 200 as cacheable for two hours, so a
  // response nobody described still needs the floor. This is the only rule that
  // applies to non-documents.
  if (!input.stated)
    return { _tag: 'floor' }

  if (!input.isDocument)
    return { _tag: 'leave' }

  if (PRESERVED_STATUSES.has(input.status))
    return { _tag: 'leave' }

  // The app said something, but not something that puts this in a shared cache.
  if (input.requestedSeconds === null)
    return { _tag: 'leave' }

  // Proven properties of this response, not guesses about intent. A shared
  // cache keys on the URL, so a personalised document stored once is served to
  // everyone, and a transient error is pinned for the whole window.
  if (input.authenticated)
    return { _tag: 'override', reason: 'the request carried credentials' }
  if (input.setsCookie)
    return { _tag: 'override', reason: 'the response set a cookie' }
  if (!varyIsSatisfiable(input.vary))
    return { _tag: 'override', reason: `the response varies on \`${input.vary}\`, which a shared cache cannot key on` }
  if (input.status !== 200)
    return { _tag: 'override', reason: `the response status was ${input.status}` }

  if (input.mode === 'no-store')
    return { _tag: 'override', reason: 'workersCache.html is set to no-store' }
  if (input.mode === 'app')
    return { _tag: 'leave' }

  if (input.guarantee._tag === 'none')
    return { _tag: 'override', reason: `no module guarantees chunk retention (${input.guarantee.reason})` }

  if (input.requestedSeconds > input.guarantee.ceilingSeconds) {
    return {
      _tag: 'clamp',
      toSeconds: input.guarantee.ceilingSeconds,
      fromSeconds: input.requestedSeconds,
      by: input.guarantee.by,
    }
  }

  return { _tag: 'leave' }
}

/**
 * The header with its total served lifetime brought inside the ceiling.
 *
 * Every directive that keeps a response servable is lowered, not just the
 * freshness one. An earlier version rewrote `s-maxage` alone, so
 * `s-maxage=300, stale-while-revalidate=86400` came back byte-identical while
 * the code logged "the value was lowered": a shared cache would still serve
 * that document for a day past the window the ceiling promises.
 *
 * `max-age` is lowered even when `s-maxage` is present. `s-maxage` decides what
 * a shared cache does, but `max-age` still governs browsers and any cache that
 * does not implement `s-maxage`, and those are the caches with no notion of a
 * deploy.
 *
 * The stale window gets whatever budget is left after freshness, so
 * `freshness + stale` can never exceed the ceiling.
 */
export function clampSharedCacheSeconds(cacheControl: string, seconds: number): string {
  const lower = (name: string, limit: number, source: string): string =>
    source.replace(
      new RegExp(`((?:^|[,\\s])${name}\\s*=\\s*)(\\d+)`, 'gi'),
      (whole, lead: string, value: string) => (Number(value) > limit ? `${lead}${limit}` : whole),
    )

  let out = lower('s-maxage', seconds, cacheControl)
  out = lower('max-age', seconds, out)

  const freshness = Math.min(
    directive(unqualify(out.toLowerCase()), 's-maxage')
    ?? directive(unqualify(out.toLowerCase()), 'max-age')
    ?? seconds,
    seconds,
  )
  const staleBudget = Math.max(0, seconds - freshness)
  out = lower('stale-while-revalidate', staleBudget, out)
  // `stale-if-error` only applies when the origin is failing, so it does not
  // share the freshness budget, but it still must not outlive the chunks.
  out = lower('stale-if-error', seconds, out)

  // Deliberately no `s-maxage` is appended when the header lacks one.
  // Cloudflare treats `s-maxage` as implying `proxy-revalidate`, which disables
  // `stale-while-revalidate` and `stale-if-error` outright: "use `max-age` for
  // the freshness window, not `s-maxage`". Adding one to guarantee an edge
  // bound would silently convert a working stale-serving policy into blocking
  // revalidation. `max-age` already bounds the edge when `s-maxage` is absent,
  // and it is clamped above.
  return out
}

/**
 * Whether this header asks for stale serving that Cloudflare will ignore.
 *
 * `s-maxage`, `must-revalidate` and `proxy-revalidate` each forbid serving
 * stale content, so pairing any of them with `stale-while-revalidate` or
 * `stale-if-error` means those directives do nothing. All three sites that
 * hand-wrote this policy left a comment about the trap, which is a good sign it
 * deserves a warning rather than a comment.
 */
export function staleDirectivesAreDisabled(cacheControl: unknown): boolean {
  const raw = Array.isArray(cacheControl) ? cacheControl.join(', ') : cacheControl
  if (typeof raw !== 'string')
    return false
  const value = unqualify(raw.toLowerCase())
  const wantsStale = /stale-while-revalidate\s*=|stale-if-error\s*=/.test(value)
  if (!wantsStale)
    return false
  return /(?:^|,)\s*(?:s-maxage\s*=|must-revalidate|proxy-revalidate)/.test(value)
}
