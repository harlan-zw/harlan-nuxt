import { describe, expect, it } from 'vitest'
import { defineCheck, fail, pass, runChecks, skipped, warn } from '../src/runtime/server'

describe('runChecks', () => {
  it('keeps failures separate from missing coverage', async () => {
    const report = await runChecks([
      defineCheck({ id: 'catalog', run: () => fail('Catalog stalled.', { hours: 24 }) }),
      defineCheck({ id: 'provider', run: () => { throw new Error('secret token') } }),
      defineCheck({ id: 'paused', run: () => skipped('Collection is paused.') }),
    ])
    expect(report.severity).toBe('fail')
    expect(report.coverage).toBe('incomplete')
    expect(report.results.map(r => r.result)).toEqual([
      fail('Catalog stalled.', { hours: 24 }),
      { _tag: 'Unavailable', reason: 'Check threw an exception.' },
      skipped('Collection is paused.'),
    ])
  })

  it('reports an empty registry as incomplete', async () => {
    expect(await runChecks([])).toMatchObject({ coverage: 'incomplete', severity: 'pass', results: [] })
  })

  it('rejects duplicate IDs before executing checks', async () => {
    let calls = 0
    const check = defineCheck({ id: 'same', run: () => {
      calls++
      return pass()
    } })
    await expect(runChecks([check, check])).rejects.toThrow('Duplicate check ID: same')
    expect(calls).toBe(0)
  })

  it('aborts timed out checks and still runs later checks', async () => {
    let signal: AbortSignal | undefined
    const report = await runChecks([
      defineCheck({ id: 'slow', run: (context) => {
        signal = context.signal
        return new Promise(() => {})
      } }),
      defineCheck({ id: 'next', run: () => warn('Needs attention.') }),
    ], { concurrency: 1, timeoutMs: 5 })
    expect(signal?.aborted).toBe(true)
    expect(report.results.map(r => r.result)).toEqual([
      { _tag: 'Unavailable', reason: 'Check exceeded its deadline.' },
      warn('Needs attention.'),
    ])
  })

  it('limits concurrency and gives every check the same observation time', async () => {
    let active = 0
    let peak = 0
    const observed: number[] = []
    const checks = Array.from({ length: 5 }, (_, i) => defineCheck({
      id: `check.${i}`,
      async run({ now }) {
        observed.push(now.getTime())
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 2))
        active--
        return pass()
      },
    }))
    const report = await runChecks(checks, { concurrency: 2, now: new Date(1234) })
    expect(peak).toBe(2)
    expect(observed).toEqual([1234, 1234, 1234, 1234, 1234])
    expect(report.coverage).toBe('complete')
  })

  it('does not execute checks after caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const report = await runChecks([defineCheck({ id: 'cancelled', run: () => {
      calls++
      return pass()
    } })], { signal: controller.signal })
    expect(calls).toBe(0)
    expect(report.coverage).toBe('incomplete')
  })

  it('rejects evidence that cannot be returned as JSON', async () => {
    const report = await runChecks([defineCheck({ id: 'invalid', run: () => pass({ value: 1n }) })])
    expect(report.coverage).toBe('incomplete')
    expect(() => JSON.stringify(report)).not.toThrow()
  })

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid concurrency %s', async (concurrency) => {
    await expect(runChecks([], { concurrency })).rejects.toThrow('positive integer')
  })
})
