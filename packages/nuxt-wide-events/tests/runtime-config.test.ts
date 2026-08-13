import { describe, expect, it } from 'vitest'
import { resolveWideEventsRuntimeConfig } from '../src/build/runtime-config'

describe('resolveWideEventsRuntimeConfig', () => {
  it('omits route and sampling policy by default', () => {
    expect(resolveWideEventsRuntimeConfig({ console: true, drain: false })).toEqual({
      console: true,
      drain: false,
    })
  })

  it('compiles route globs once and specializes observed sampling policy', () => {
    const config = resolveWideEventsRuntimeConfig({
      console: false,
      drain: false,
      exclude: ['/api/_nuxt_icon/**', '/health', '/users/?'],
      sampling: {
        rates: { debug: 0, error: 5, info: 10, warn: 50 },
        keep: [{ duration: 1000 }, { duration: 2000 }, { status: 500 }, { status: 400 }],
      },
    })

    expect(config.exclude).toBeInstanceOf(RegExp)
    expect(config.exclude?.test('/api/_nuxt_icon/foo/bar')).toBe(true)
    expect(config.exclude?.test('/api/_nuxt_icon')).toBe(false)
    expect(config.exclude?.test('/health')).toBe(true)
    expect(config.exclude?.test('/users/a')).toBe(true)
    expect(config.exclude?.test('/users/ab')).toBe(false)
    expect(config.sampling).toEqual({ debug: 0, duration: 1000, error: 5, info: 10, status: 400, warn: 50 })
  })

  it.each([
    ['a negative rate', { sampling: { rates: { info: -1 } } }, 'wideEvents.sampling.rates.info'],
    ['a rate over 100', { sampling: { rates: { error: 101 } } }, 'wideEvents.sampling.rates.error'],
    ['a non-finite rate', { sampling: { rates: { warn: Infinity } } }, 'wideEvents.sampling.rates.warn'],
    ['a negative duration', { sampling: { keep: [{ duration: -1 }] } }, 'wideEvents.sampling.keep[0].duration'],
    ['a decimal status', { sampling: { keep: [{ status: 400.5 }] } }, 'wideEvents.sampling.keep[0].status'],
  ])('rejects %s', (_label, input, expected) => {
    expect(() => resolveWideEventsRuntimeConfig(input as never)).toThrow(expected)
  })

  it('keeps standalone rates for createWideEvent', () => {
    expect(resolveWideEventsRuntimeConfig({
      sampling: { rates: { debug: 1, error: 2, info: 3, warn: 4 } },
    }).sampling).toEqual({ debug: 1, error: 2, info: 3, warn: 4 })
  })
})
