import { describe, expect, it } from 'vitest'
import { defineCheck, pass, runChecks } from '../src/runtime/server'

describe('run safeguards', () => {
  it('keeps a missing required check visible', async () => {
    const report = await runChecks([defineCheck({ id: 'present', run: () => pass() })], { required: ['present', 'deleted'] })
    expect(report.coverage).toBe('incomplete')
    expect(report.results.find(r => r.id === 'deleted')?.result).toEqual({ _tag: 'Unavailable', reason: 'Required check is not registered.' })
  })

  it('stops starting work when the total deadline expires', async () => {
    let calls = 0
    const report = await runChecks(['slow', 'queued'].map(id => defineCheck({ id, run: () => {
      calls++
      return new Promise(() => {})
    } })), { concurrency: 1, timeoutMs: 1000, totalTimeoutMs: 5 })
    expect(calls).toBe(1)
    expect(report.results.map(r => r.result)).toEqual([
      { _tag: 'Unavailable', reason: 'Run exceeded its deadline.' },
      { _tag: 'Unavailable', reason: 'Run exceeded its deadline.' },
    ])
  })

  it('shares collection within one run without sharing across runs', async () => {
    let reads = 0
    const resource = {}
    const check = (id: string) => defineCheck({ id, async run(context) {
      const value = await context.collect(resource, 'test.read', async () => ({ value: ++reads, metrics: { requests: 1, rowsRead: 7 } }))
      return pass({ value })
    } })
    const checks = [check('a'), check('b')]
    const first = await runChecks(checks)
    expect(first.results.map(r => r.result)).toEqual([pass({ value: 1 }), pass({ value: 1 })])
    expect(first.collections).toMatchObject([{ key: 'test.read', requests: 1, rowsRead: 7 }])
    const second = await runChecks(checks)
    expect(second.results[0]?.result).toEqual(pass({ value: 2 }))
  })

  it('does not cancel shared collection when one consumer times out', async () => {
    const resource = {}
    let aborted = false
    const load = async (signal: AbortSignal) => {
      await new Promise(resolve => setTimeout(resolve, 15))
      aborted = signal.aborted
      return { value: 1 }
    }
    const first = defineCheck({ id: 'first', run: async ctx => pass({ value: await ctx.collect(resource, 'shared', load) }) })
    const second = defineCheck({ id: 'second', run: async ctx => pass({ value: await ctx.collect(resource, 'shared', load) }) })
    const report = await runChecks([first, second], { concurrency: 1, timeoutMs: 10, totalTimeoutMs: 1000 })
    expect(report.results[0]?.result._tag).toBe('Unavailable')
    expect(report.results[1]?.result).toEqual(pass({ value: 1 }))
    expect(aborted).toBe(false)
  })

  it('copies the report identity and validates it before executing', async () => {
    const identity = { site: 'example.com', environment: 'production', deployment: 'abc123' }
    expect(await runChecks([], { identity })).toMatchObject({ schemaVersion: 1, identity })
    await expect(runChecks([], { identity: { ...identity, deployment: '' } })).rejects.toThrow('identity')
  })
})

it('serializes different collections against the same resource', async () => {
  let active = 0
  let peak = 0
  const resource = {}
  await runChecks(['a', 'b'].map(id => defineCheck({ id, async run(ctx) {
    await ctx.collect(resource, id, async () => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      return { value: 1 }
    })
    return pass()
  } })))
  expect(peak).toBe(1)
})
