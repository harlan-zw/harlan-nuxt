import { describe, expect, it } from 'vitest'
import {
  clampSharedCacheSeconds,
  resolveHtmlCacheGuarantee,
  responseCacheDecision,
  sharedCacheSeconds,
  staleDirectivesAreDisabled,
  varyIsSatisfiable,
} from '../src/runtime/server/utils/workers-cache'

const skew = {
  v: 1 as const,
  by: 'nuxt-skew-protection',
  documentTtlCeilingSeconds: 2_592_000,
  basis: 'retention-days' as const,
  assetRecovery: true,
}

const bounded = resolveHtmlCacheGuarantee([skew])
const none = resolveHtmlCacheGuarantee([])

function decide(over: Partial<Parameters<typeof responseCacheDecision>[0]> = {}) {
  return responseCacheDecision({
    mode: 'auto',
    guarantee: bounded,
    isDocument: true,
    stated: true,
    requestedSeconds: 300,
    status: 200,
    authenticated: false,
    setsCookie: false,
    vary: undefined,
    ...over,
  })
}

describe('reading what a module can promise', () => {
  it('takes the weakest ceiling across publishers', () => {
    const other = { ...skew, by: 'other', documentTtlCeilingSeconds: 600 }

    expect(resolveHtmlCacheGuarantee([skew, other]))
      .toMatchObject({ _tag: 'bounded', ceilingSeconds: 600 })
  })

  // Retaining builds is what turns a stale document from a ChunkLoadError into
  // a slow page. A ceiling without it is a promise nobody can keep.
  it('refuses a promise from a module that cannot serve old builds', () => {
    expect(resolveHtmlCacheGuarantee([{ ...skew, assetRecovery: false }]))
      .toEqual({ _tag: 'none', reason: 'no-asset-recovery' })
  })

  it('ignores a version it does not understand rather than guessing', () => {
    expect(resolveHtmlCacheGuarantee([{ ...skew, v: 2 }]))
      .toEqual({ _tag: 'none', reason: 'unknown-version' })
  })

  it.each([undefined, null, [], 'nonsense'])('treats %s as no promise at all', (value) => {
    expect(resolveHtmlCacheGuarantee(value)).toMatchObject({ _tag: 'none' })
  })
})

describe('deciding one response', () => {
  it('honours a rule inside the guaranteed window', () => {
    expect(decide()).toEqual({ _tag: 'leave' })
  })

  it('lowers a rule that outlives the guarantee instead of discarding it', () => {
    expect(decide({ requestedSeconds: 31_536_000 }))
      .toMatchObject({ _tag: 'clamp', toSeconds: 2_592_000, fromSeconds: 31_536_000 })
  })

  // The failure that made this worse than doing nothing: nitro's own
  // `/_nuxt/**` immutable rule, and every API route, went through the document
  // policy and came out `private, no-store`.
  it('never touches a response that is not a document', () => {
    expect(decide({ isDocument: false, requestedSeconds: 31_536_000, mode: 'no-store' }))
      .toEqual({ _tag: 'leave' })
    expect(decide({ isDocument: false, authenticated: true })).toEqual({ _tag: 'leave' })
    expect(decide({ isDocument: false, status: 503 })).toEqual({ _tag: 'leave' })
  })

  it('still floors a response nobody described, so Workers Cache cannot guess', () => {
    expect(decide({ stated: false })).toEqual({ _tag: 'floor' })
    expect(decide({ stated: false, isDocument: false })).toEqual({ _tag: 'floor' })
  })

  it('leaves a stated policy that does not ask for sharing', () => {
    expect(decide({ requestedSeconds: null })).toEqual({ _tag: 'leave' })
  })

  // A 304 updates the stored response's headers, so forcing no-store onto one
  // evicts the entry it just validated.
  it.each([301, 304, 308])('never rewrites a %i', (status) => {
    expect(decide({ status, mode: 'no-store', authenticated: true })).toEqual({ _tag: 'leave' })
  })

  // Shared caches key on the URL, so one stored personalised document is
  // served to everyone who asks for that path.
  it('overrides a credentialed request however the app configured it', () => {
    expect(decide({ authenticated: true, mode: 'app' }))
      .toMatchObject({ _tag: 'override', reason: 'the request carried credentials' })
  })

  it('overrides a response that mints a cookie', () => {
    expect(decide({ setsCookie: true, mode: 'app' }))
      .toMatchObject({ _tag: 'override', reason: 'the response set a cookie' })
  })

  it('overrides a transient error however the app configured it', () => {
    expect(decide({ status: 503, mode: 'app' })).toMatchObject({ _tag: 'override' })
  })

  it('overrides when nothing guarantees retention', () => {
    expect(decide({ guarantee: none })).toMatchObject({ _tag: 'override' })
  })

  it('honours the app outright when told to', () => {
    expect(decide({ guarantee: none, mode: 'app' })).toEqual({ _tag: 'leave' })
  })

  it('keeps the old behaviour when told to', () => {
    expect(decide({ mode: 'no-store' })).toMatchObject({ _tag: 'override' })
  })
})

describe('lowering the whole served lifetime', () => {
  it('rewrites the number and keeps every other directive', () => {
    expect(clampSharedCacheSeconds('public, s-maxage=31536000, stale-if-error=86400', 600))
      .toBe('public, s-maxage=600, stale-if-error=600')
  })

  // The stale window is served time too. Clamping only `s-maxage` returned a
  // byte-identical header while logging "the value was lowered".
  it('lowers the stale window, which used to escape entirely', () => {
    const out = clampSharedCacheSeconds('public, s-maxage=300, stale-while-revalidate=86400', 600)

    expect(sharedCacheSeconds(out)).toBeLessThanOrEqual(600)
    expect(out).not.toContain('86400')
  })

  it('lowers the browser directive even when a shared one is present', () => {
    expect(clampSharedCacheSeconds('public, max-age=31536000, s-maxage=100', 600))
      .toBe('public, max-age=600, s-maxage=100')
  })

  it('leaves a value already inside the window alone', () => {
    expect(clampSharedCacheSeconds('public, s-maxage=60', 600)).toBe('public, s-maxage=60')
  })

  // Cloudflare reads `s-maxage` as implying `proxy-revalidate`, which disables
  // stale serving. Appending one to guarantee an edge bound would convert a
  // working stale-serving policy into blocking revalidation, and `max-age`
  // already bounds the edge when `s-maxage` is absent.
  it('never invents an s-maxage, which would disable stale serving', () => {
    expect(clampSharedCacheSeconds('public, max-age=99999', 600))
      .toBe('public, max-age=600')
    expect(clampSharedCacheSeconds('public, max-age=99999, stale-while-revalidate=99999', 600))
      .not
      .toContain('s-maxage')
  })

  it('never lets a clamped header exceed the ceiling', () => {
    const cases = [
      'public, s-maxage=300, stale-while-revalidate=100000',
      'public, s-maxage=31536000, stale-while-revalidate=31536000',
      'public, max-age=100, stale-while-revalidate=86400',
      'public, max-age=3600, stale-while-revalidate=86400, private="set-cookie"',
    ]

    for (const input of cases)
      expect(sharedCacheSeconds(clampSharedCacheSeconds(input, 600))).toBeLessThanOrEqual(600)
  })
})

describe('reading a cache-control', () => {
  it('counts the stale window, since a stale document is still served', () => {
    expect(sharedCacheSeconds('public, s-maxage=300, stale-while-revalidate=600')).toBe(900)
  })

  it.each(['private, no-store', 'no-store', 'public, max-age=0, must-revalidate'])('refuses %s', (value) => {
    expect(sharedCacheSeconds(value)).toBeNull()
  })
})

describe('the qualified private directive', () => {
  // `private="set-cookie"` names the fields a shared cache must drop. It is
  // how gscdump.com keeps a Set-Cookie response storable, and reading it as a
  // blanket refusal would discard exactly that pattern.
  it('is not a refusal', () => {
    expect(sharedCacheSeconds('public, max-age=3600, private="set-cookie"')).toBe(3600)
  })

  it('still refuses bare private', () => {
    expect(sharedCacheSeconds('private, max-age=3600')).toBeNull()
    expect(sharedCacheSeconds('max-age=3600, private')).toBeNull()
  })

  it('is not fooled by no-store inside a quoted argument', () => {
    expect(sharedCacheSeconds('public, max-age=60, private="x-no-store"')).toBe(60)
  })

  // The browser copy revalidates every time while the edge holds the real TTL.
  // Read on its own, `max-age=0` looks like a refusal.
  it('reads the edge header when the browser one is deliberately zero', () => {
    expect(sharedCacheSeconds('public, max-age=0, private="set-cookie"')).toBeNull()
    expect(sharedCacheSeconds('public, max-age=3600, stale-while-revalidate=86400, private="set-cookie"')).toBe(90_000)
  })
})

describe('a capability crossing a package boundary is parsed, not trusted', () => {
  // `htmlCacheCapabilities` is an unnamespaced runtime-config key, so anything
  // can write to it. Coercing a string or a boolean into `Math.min` would let a
  // one-line config publish a thousand-year guarantee.
  it.each([
    ['a string ceiling', { documentTtlCeilingSeconds: '1e12' }],
    ['an array ceiling', { documentTtlCeilingSeconds: [7200] }],
    ['a boolean ceiling', { documentTtlCeilingSeconds: true }],
    ['a fractional ceiling', { documentTtlCeilingSeconds: 1.5 }],
    ['a truthy string for assetRecovery', { assetRecovery: 'false' }],
    ['an object author', { by: { a: 1 } }],
    ['an empty author', { by: '' }],
    ['an invented basis', { basis: 'vibes' }],
  ])('refuses %s', (_label, override) => {
    expect(resolveHtmlCacheGuarantee([{ ...skew, ...override }]))
      .toMatchObject({ _tag: 'none' })
  })

  it('still accepts a well-formed one', () => {
    expect(resolveHtmlCacheGuarantee([skew])).toMatchObject({ _tag: 'bounded' })
  })
})

describe('the parser', () => {
  it('tolerates whitespace around the equals sign', () => {
    expect(sharedCacheSeconds('public,   max-age = 60')).toBe(60)
  })

  it('takes the most restrictive of a duplicated directive', () => {
    expect(sharedCacheSeconds('max-age=99999, max-age=60')).toBe(60)
    expect(sharedCacheSeconds('max-age=60, max-age=99999')).toBe(60)
  })

  it('does not read no-store out of another token', () => {
    expect(sharedCacheSeconds('public, max-age=60, x-no-store-test')).toBe(60)
  })

  it('treats no-cache as a refusal, since it forbids reuse without revalidating', () => {
    expect(sharedCacheSeconds('public, max-age=60, no-cache')).toBeNull()
  })

  it('cannot have a lifetime smuggled through a quoted argument', () => {
    expect(sharedCacheSeconds('private="x, s-maxage=99999"')).toBeNull()
  })

  it('bounds an absurd number', () => {
    expect(sharedCacheSeconds('public, max-age=99999999999999999999')).toBe(31_536_000)
  })
})

describe('vary', () => {
  // Deliberately not invented where the app set none. Injecting `Accept` or
  // `Accept-Language` would collapse the hit rate on every route that does not
  // negotiate, and hide the app's bug on the ones that do.
  it('does not stand in the way when the app set none', () => {
    expect(varyIsSatisfiable(undefined)).toBe(true)
    expect(decide({ vary: undefined })).toEqual({ _tag: 'leave' })
  })

  it('accepts a header a URL-keyed cache can honour', () => {
    expect(varyIsSatisfiable('Accept-Language')).toBe(true)
    expect(varyIsSatisfiable('Accept-Encoding, Accept-Language')).toBe(true)
  })

  // A shared cache does not key on these, so storing the response anyway
  // serves one person's copy to everyone.
  it.each(['*', 'Cookie', 'Accept, Cookie', 'authorization', 'Accept-Encoding, AUTHORIZATION'])(
    'refuses a response varying on %s',
    (vary) => {
      expect(varyIsSatisfiable(vary)).toBe(false)
      expect(decide({ vary })).toMatchObject({ _tag: 'override' })
    },
  )

  it('refuses even when the app owns the risk, because this one is not theirs to own', () => {
    expect(decide({ vary: 'Cookie', mode: 'app' })).toMatchObject({ _tag: 'override' })
  })
})

describe('the s-maxage trap', () => {
  // Every site that hand-wrote this policy left a comment about it, which is a
  // good sign it deserves a warning rather than a comment.
  it.each([
    'public, s-maxage=300, stale-while-revalidate=600',
    'public, s-maxage=300, stale-if-error=600',
    'public, max-age=300, must-revalidate, stale-while-revalidate=600',
    'public, max-age=300, proxy-revalidate, stale-if-error=600',
  ])('spots that %s disables its own stale serving', (value) => {
    expect(staleDirectivesAreDisabled(value)).toBe(true)
  })

  it.each([
    'public, max-age=300, stale-while-revalidate=600',
    'public, s-maxage=300',
    'public, max-age=300',
    'private, no-store',
  ])('leaves %s alone', (value) => {
    expect(staleDirectivesAreDisabled(value)).toBe(false)
  })
})
