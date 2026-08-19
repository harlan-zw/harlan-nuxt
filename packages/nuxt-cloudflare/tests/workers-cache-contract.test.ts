import { describe, expect, it } from 'vitest'
import {
  clampSharedCacheSeconds,
  documentCacheDecision,
  resolveHtmlCacheGuarantee,
  sharedCacheSeconds,
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

function decide(over: Partial<Parameters<typeof documentCacheDecision>[0]> = {}) {
  return documentCacheDecision({
    mode: 'auto',
    guarantee: bounded,
    cacheControl: 'public, s-maxage=300',
    status: 200,
    authenticated: false,
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

describe('deciding one document', () => {
  it('honours a rule inside the guaranteed window', () => {
    expect(decide()).toEqual({ _tag: 'honour' })
  })

  it('lowers a rule that outlives the guarantee instead of discarding it', () => {
    expect(decide({ cacheControl: 'public, s-maxage=31536000' }))
      .toMatchObject({ _tag: 'clamp', toSeconds: 2_592_000, fromSeconds: 31_536_000 })
  })

  // Nobody stated a policy, so the floor applies and nothing was taken. This
  // is the common case and it must never warn.
  it('falls to the floor when the app said nothing', () => {
    expect(decide({ cacheControl: undefined })).toMatchObject({ _tag: 'floor' })
  })

  it('falls to the floor when the app already said private', () => {
    expect(decide({ cacheControl: 'private, no-store' })).toMatchObject({ _tag: 'floor' })
  })

  // Shared caches key on the URL, so one stored personalised document is
  // served to everyone who asks for that path.
  it('overrides a credentialed request however the app configured it', () => {
    expect(decide({ authenticated: true, mode: 'app' }))
      .toMatchObject({ _tag: 'override', reason: 'the request carried credentials' })
  })

  it('overrides a non-200 however the app configured it', () => {
    expect(decide({ status: 503, mode: 'app' }))
      .toMatchObject({ _tag: 'override' })
  })

  it('overrides when nothing guarantees retention', () => {
    expect(decide({ guarantee: none })).toMatchObject({ _tag: 'override' })
  })

  it('honours the app outright when told to', () => {
    expect(decide({ guarantee: none, mode: 'app' })).toEqual({ _tag: 'honour' })
  })

  it('keeps the old behaviour when told to', () => {
    expect(decide({ mode: 'no-store' })).toMatchObject({ _tag: 'override' })
  })
})

describe('lowering a lifetime without discarding the rest', () => {
  it('rewrites the number and keeps every other directive', () => {
    expect(clampSharedCacheSeconds('public, s-maxage=31536000, stale-if-error=86400', 600))
      .toBe('public, s-maxage=600, stale-if-error=86400')
  })

  it('leaves a value already inside the window alone', () => {
    expect(clampSharedCacheSeconds('public, s-maxage=60', 600)).toBe('public, s-maxage=60')
  })

  it('adds a shared lifetime when the app only set a browser one', () => {
    expect(clampSharedCacheSeconds('public, max-age=99999', 600))
      .toBe('public, max-age=600, s-maxage=600')
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
