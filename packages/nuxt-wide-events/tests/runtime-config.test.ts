import { describe, expect, it } from 'vitest'
import { resolveWideEventsRuntimeConfig, serializeWideEventsRuntimeConfig } from '../src/build/runtime-config'

describe('resolveWideEventsRuntimeConfig', () => {
  it('omits route and sampling policy by default', () => {
    expect(resolveWideEventsRuntimeConfig({})).toEqual({
      console: true,
      drain: false,
    })
  })

  it('stops console output when a drain owns the record', () => {
    expect(resolveWideEventsRuntimeConfig({ drain: true })).toEqual({
      console: false,
      drain: true,
    })
    expect(resolveWideEventsRuntimeConfig({ console: true, drain: true })).toEqual({
      console: true,
      drain: true,
    })
  })

  it('compiles route globs once and specializes observed sampling policy', () => {
    const config = resolveWideEventsRuntimeConfig({
      console: false,
      drain: false,
      exclude: ['/api/_nuxt_icon/**', '/health', '/users/?'],
      sampling: {
        rates: { debug: 0, error: 5, info: 10, warn: 50 },
        keep: [{ duration: 1000 }, { status: 500 }],
      },
    })

    expect(config.exclude).toBeInstanceOf(RegExp)
    expect(config.exclude?.test('/api/_nuxt_icon/foo/bar')).toBe(true)
    expect(config.exclude?.test('/api/_nuxt_icon')).toBe(true)
    expect(config.exclude?.test('/api/_nuxt_iconography')).toBe(false)
    expect(config.exclude?.test('/health')).toBe(true)
    expect(config.exclude?.test('/users/a')).toBe(true)
    expect(config.exclude?.test('/users/ab')).toBe(false)
    expect(config.sampling).toEqual({
      debug: 0,
      error: 5,
      info: 10,
      keep: [{ duration: 1000 }, { status: 500 }],
      warn: 50,
    })
  })

  it('keeps each condition whole so both parts must match', () => {
    expect(resolveWideEventsRuntimeConfig({
      sampling: { keep: [{ duration: 1000, status: 500 }] },
    }).sampling).toEqual({ keep: [{ duration: 1000, status: 500 }] })
  })

  it.each([
    ['a negative rate', { sampling: { rates: { info: -1 } } }, 'wideEvents.sampling.rates.info'],
    ['a rate over 100', { sampling: { rates: { error: 101 } } }, 'wideEvents.sampling.rates.error'],
    ['a non-finite rate', { sampling: { rates: { warn: Infinity } } }, 'wideEvents.sampling.rates.warn'],
    ['a negative duration', { sampling: { keep: [{ duration: -1 }] } }, 'wideEvents.sampling.keep[0].duration'],
    ['a decimal status', { sampling: { keep: [{ status: 400.5 }] } }, 'wideEvents.sampling.keep[0].status'],
    ['an empty condition', { sampling: { keep: [{}] } }, 'wideEvents.sampling.keep[0]'],
  ])('rejects %s', (_label, input, expected) => {
    expect(() => resolveWideEventsRuntimeConfig(input as never)).toThrow(expected)
  })

  it('keeps standalone rates for createWideEvent', () => {
    expect(resolveWideEventsRuntimeConfig({
      sampling: { rates: { debug: 1, error: 2, info: 3, warn: 4 } },
    }).sampling).toEqual({ debug: 1, error: 2, info: 3, warn: 4 })
  })

  it('serializes the compiled route pattern for the runtime', () => {
    const config = resolveWideEventsRuntimeConfig({
      exclude: ['/api/_content/**'],
      sampling: { keep: [{ duration: 1000, status: 500 }] },
    })
    // eslint-disable-next-line no-new-func
    const runtime = new Function(serializeWideEventsRuntimeConfig(config).replace('export default', 'return'))() as {
      exclude: RegExp
      sampling: { keep: { duration?: number, status?: number }[] }
    }

    expect(runtime.exclude.test('/api/_content')).toBe(true)
    expect(runtime.exclude.test('/api/_content/query')).toBe(true)
    expect(runtime.sampling.keep).toEqual([{ duration: 1000, status: 500 }])
  })
})
