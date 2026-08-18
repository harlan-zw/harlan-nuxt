import type { ErrorReport } from '../src/runtime/shared/types'
import { describe, expect, it } from 'vitest'
import {
  isSecretKey,
  REDACTED,
  redactErrorReport,
  redactText,
  redactValue,
} from '../src/runtime/shared/redact'

describe('redactText', () => {
  it('keeps a credential query parameter name and removes its value', () => {
    expect(redactText('Failed to fetch https://api.example.com/v1?key=AIzaSyD1234567890abcdefghijkl&site=x'))
      .toBe(`Failed to fetch https://api.example.com/v1?key=${REDACTED}&site=x`)
  })

  it('removes a credential at the start of a bare query string', () => {
    expect(redactText('access_token=ya29.a0AfB_verylongtokenvalue&scope=read'))
      .toBe(`access_token=${REDACTED}&scope=read`)
  })

  it('removes a Google OAuth access token quoted into a message', () => {
    expect(redactText('GSC call failed with ya29.A0ARrdaM9xxxxxxxxxxxxxxxxxxxx'))
      .toBe(`GSC call failed with ${REDACTED}`)
  })

  it('removes a Google OAuth refresh token', () => {
    expect(redactText('refresh 1//0gLongRefreshTokenValue123456 expired'))
      .toBe(`refresh ${REDACTED} expired`)
  })

  it('removes a Google API key', () => {
    expect(redactText('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q')).toBe(REDACTED)
  })

  it('removes a bearer token but keeps the scheme, which names the leak', () => {
    expect(redactText('authorization: Bearer abc.def-ghi_jkl'))
      .toBe(`authorization: Bearer ${REDACTED}`)
  })

  it('removes a basic authorization header value', () => {
    expect(redactText('Authorization: Basic dXNlcjpwYXNzd29yZA==').toLowerCase())
      .toContain(REDACTED)
  })

  it('removes a whole cookie header', () => {
    expect(redactText('cookie: nuxt-session=abc123; theme=dark'))
      .toBe(`cookie: ${REDACTED}`)
  })

  it('removes a session cookie assignment outside a header', () => {
    expect(redactText('set nuxt-session=abcdef123456 for the visitor'))
      .toBe(`set nuxt-session=${REDACTED} for the visitor`)
  })

  it('removes a JWT', () => {
    expect(redactText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123'))
      .toBe(`token ${REDACTED}`)
  })

  it('removes credentials from a userinfo URL', () => {
    expect(redactText('connect to https://admin:hunter2@db.example.com/main'))
      .toBe(`connect to https://${REDACTED}@db.example.com/main`)
  })

  it('removes a GitHub token, a Stripe key and an OpenAI key', () => {
    expect(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe(REDACTED)
    expect(redactText('sk_live_ABCDEFGHIJKLMNOP')).toBe(REDACTED)
    expect(redactText('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX')).toBe(REDACTED)
  })

  it('removes a Sentry DSN', () => {
    expect(redactText('dsn https://5a73fdc73e42eb95936085b70f7ebd12@o1.ingest.us.sentry.io/45115'))
      .toBe(`dsn ${REDACTED}`)
  })

  it('leaves text with no credential unchanged', () => {
    const clean = 'Cannot read properties of undefined (reading id) at /api/sites?page=2'
    expect(redactText(clean)).toBe(clean)
  })
})

describe('isSecretKey', () => {
  it('matches an exact secret name whatever its casing or punctuation', () => {
    expect(isSecretKey('Authorization')).toBe(true)
    expect(isSecretKey('x-api-key')).toBe(true)
    expect(isSecretKey('refresh_token')).toBe(true)
  })

  it('matches a suffix so a prefixed name needs no list entry', () => {
    expect(isSecretKey('googleApiKey')).toBe(true)
    expect(isSecretKey('gscRefreshToken')).toBe(true)
    expect(isSecretKey('clientSecret')).toBe(true)
  })

  it('keeps a debugging key that only ends in key', () => {
    expect(isSecretKey('cacheKey')).toBe(false)
    expect(isSecretKey('sortKey')).toBe(false)
  })

  it('matches an extra key a site declares', () => {
    expect(isSecretKey('dataForSeoLogin')).toBe(false)
    expect(isSecretKey('dataForSeoLogin', ['data_for_seo_login'])).toBe(true)
  })
})

describe('redactValue', () => {
  it('removes a secret by key name even when the value looks ordinary', () => {
    expect(redactValue({ apiKey: 'plain-looking-value', page: 2 }))
      .toEqual({ apiKey: REDACTED, page: 2 })
  })

  it('removes a secret nested inside an array', () => {
    expect(redactValue({ calls: [{ url: 'https://x.test?token=abcdefgh' }] }))
      .toEqual({ calls: [{ url: `https://x.test?token=${REDACTED}` }] })
  })

  it('reports a cycle instead of looping', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    expect(redactValue(cyclic)).toEqual({ name: 'root', self: '[circular]' })
  })

  it('stringifies a BigInt so the transport can serialise it', () => {
    expect(redactValue({ rows: 9007199254740993n })).toEqual({ rows: '9007199254740993' })
  })

  it('redacts an error cause chain', () => {
    const inner = new Error('fetch https://api.test?api_key=abcdef123456 failed')
    const outer = new Error('upstream failed', { cause: inner })
    const result = redactValue(outer) as { cause: { message: string } }
    expect(result.cause.message).toBe(`fetch https://api.test?api_key=${REDACTED} failed`)
  })

  it('caps a long array so one call site cannot fill the report', () => {
    const result = redactValue(Array.from({ length: 60 }, (_, index) => index)) as unknown[]
    expect(result).toHaveLength(51)
    expect(result.at(-1)).toBe('[+10 more]')
  })
})

describe('redactErrorReport', () => {
  it('removes a token from the message, the exception and a breadcrumb', () => {
    const report: ErrorReport = {
      message: 'GET https://searchconsole.googleapis.com/v1?access_token=ya29.abcdefghijkl',
      exception: { values: [{ type: 'FetchError', value: 'refused with token ya29.abcdefghijkl' }] },
      breadcrumbs: [{ category: 'fetch', message: 'https://x.test?key=AIzaSyABCDEFGHIJKLMNOPQRSTU' }],
    }
    const out = redactErrorReport(report)
    expect(out.message).toBe(`GET https://searchconsole.googleapis.com/v1?access_token=${REDACTED}`)
    expect(out.exception?.values?.[0]?.value).toBe(`refused with token ${REDACTED}`)
    expect(out.breadcrumbs?.[0]?.message).toBe(`https://x.test?key=${REDACTED}`)
  })

  it('drops cookies and the caller identity headers, and keeps the user id', () => {
    const out = redactErrorReport({
      user: { id: 'user_42', email: 'a@b.test', username: 'ab', ip_address: '1.2.3.4' },
      request: {
        cookies: { 'nuxt-session': 'abc' },
        headers: {
          'authorization': 'Bearer abcdef',
          'cf-connecting-ip': '1.2.3.4',
          'x-forwarded-for': '1.2.3.4',
          'user-agent': 'Chrome',
        },
      },
    })
    expect(out.user).toEqual({ id: 'user_42' })
    expect(out.request?.cookies).toBeUndefined()
    expect(out.request?.headers).toEqual({
      'authorization': REDACTED,
      'cf-connecting-ip': REDACTED,
      'x-forwarded-for': REDACTED,
      'user-agent': 'Chrome',
    })
  })

  it('redacts a query string that Sentry stores without its leading question mark', () => {
    const out = redactErrorReport({ request: { query_string: 'token=abcdef123456&page=2' } })
    expect(out.request?.query_string).toBe(`token=${REDACTED}&page=2`)
  })

  it('deep redacts the request body rather than dropping it', () => {
    const out = redactErrorReport({
      request: { data: { siteUrl: 'https://x.test', refreshToken: '1//0gSecretValue', page: 1 } },
    })
    expect(out.request?.data).toEqual({ siteUrl: 'https://x.test', refreshToken: REDACTED, page: 1 })
  })

  it('redacts extra, contexts and tags', () => {
    const out = redactErrorReport({
      extra: { authorization: 'Bearer x' },
      contexts: { upstream: { url: 'https://x.test?secret=abcdef' } },
      tags: { note: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' },
    })
    expect(out.extra).toEqual({ authorization: REDACTED })
    expect(out.contexts).toEqual({ upstream: { url: `https://x.test?secret=${REDACTED}` } })
    expect(out.tags).toEqual({ note: REDACTED })
  })

  it('does not mutate the report it was given', () => {
    const report: ErrorReport = { message: 'key=abcdef123456', request: { cookies: { a: 'b' } } }
    redactErrorReport(report)
    expect(report.message).toBe('key=abcdef123456')
    expect(report.request?.cookies).toEqual({ a: 'b' })
  })

  it('honours an extra secret key a site declares', () => {
    const out = redactErrorReport({ extra: { dataForSeoLogin: 'harlan' } }, ['dataForSeoLogin'])
    expect(out.extra).toEqual({ dataForSeoLogin: REDACTED })
  })
})
