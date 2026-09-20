import { describe, expect, it } from 'vitest'
import { resolveJevConfig, resolveJevSeatMode } from '../src/runtime/server/config'

describe('resolveJevConfig', () => {
  it('marks itself unconfigured without token and account id', () => {
    const config = resolveJevConfig({})
    expect(config.configured).toBe(false)
    expect(config.model).toBe('typesafe/jev')
    expect(config.cacheTtl).toBe(0)
    expect(config.defaultMode).toBe('shadow')
  })

  it('trims credentials and keeps configured state', () => {
    const config = resolveJevConfig({ apiToken: ' token ', accountId: ' account ' })
    expect(config).toMatchObject({ configured: true, apiToken: 'token', accountId: 'account' })
  })

  it('falls back to the default model when blank', () => {
    expect(resolveJevConfig({ apiToken: 't', accountId: 'a', model: '  ' }).model).toBe('typesafe/jev')
    expect(resolveJevConfig({ apiToken: 't', accountId: 'a', model: 'other/model' }).model).toBe('other/model')
  })

  it('floors cacheTtl at zero', () => {
    expect(resolveJevConfig({ cacheTtl: -5 }).cacheTtl).toBe(0)
    expect(resolveJevConfig({ cacheTtl: 90.9 }).cacheTtl).toBe(90)
  })

  it('drops an unknown default mode', () => {
    expect(resolveJevConfig({ defaultMode: 'bogus' }).defaultMode).toBe('shadow')
    expect(resolveJevConfig({ defaultMode: 'off' }).defaultMode).toBe('off')
  })
})

describe('resolveJevSeatMode', () => {
  it('defaults to shadow, honours pairs, drops malformed entries', () => {
    expect(resolveJevSeatMode('ctr-outlier', resolveJevConfig({}))).toBe('shadow')
    const config = resolveJevConfig({ apiToken: 't', accountId: 'a', seatModes: 'ctr-outlier=live,email-worth=off,nope,bad=bogus' })
    expect(resolveJevSeatMode('ctr-outlier', config)).toBe('live')
    expect(resolveJevSeatMode('email-worth', config)).toBe('off')
    expect(resolveJevSeatMode('brand-query', config)).toBe('shadow')
  })

  it('falls back to the configured default mode', () => {
    const config = resolveJevConfig({ apiToken: 't', accountId: 'a', defaultMode: 'off', seatModes: 'a=live' })
    expect(resolveJevSeatMode('a', config)).toBe('live')
    expect(resolveJevSeatMode('b', config)).toBe('off')
  })
})
