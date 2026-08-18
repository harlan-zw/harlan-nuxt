import { describe, expect, it, vi } from 'vitest'
import {
  assertD1BoundParameters,
  chunkD1Items,
  classifyD1RetryError,
  D1_MAX_BOUND_PARAMETERS,
  defineD1ParameterPlan,
  getRecoveringRequestD1Session,
  getRequestD1Session,
  isReplayableD1Sql,
  isTransientD1Error,
  retryIdempotentD1Write,
  withD1ResetRecovery,
} from '../src/d1'

describe('d1 parameter budget', () => {
  it('derives safe IN-list and multi-row insert sizes from the 100-bind ceiling', () => {
    expect(D1_MAX_BOUND_PARAMETERS).toBe(100)
    expect(defineD1ParameterPlan({ parametersPerItem: 100, reservedParameters: 0 }).itemsPerStatement).toBe(1)
    expect(defineD1ParameterPlan({ parametersPerItem: 1, reservedParameters: 2 }).itemsPerStatement).toBe(98)
    expect(defineD1ParameterPlan({ parametersPerItem: 17, reservedParameters: 0 }).itemsPerStatement).toBe(5)
    expect(defineD1ParameterPlan({ parametersPerItem: 8, reservedParameters: 12 }).itemsPerStatement).toBe(11)
  })

  it('chunks every item without emitting an over-budget statement', () => {
    const items = Array.from({ length: 31 }, (_, index) => index)
    const chunks = chunkD1Items(items, defineD1ParameterPlan({ parametersPerItem: 14, reservedParameters: 0 }))

    expect(chunks.map(chunk => chunk.length)).toEqual([7, 7, 7, 7, 3])
    expect(chunks.flat()).toEqual(items)
    expect(chunks.every(chunk => chunk.length * 14 <= D1_MAX_BOUND_PARAMETERS)).toBe(true)
  })

  it('covers the 100-item bulk set and remove shapes used by site investigations', () => {
    const items = Array.from({ length: 100 }, (_, index) => index)
    const setPlan = defineD1ParameterPlan({ parametersPerItem: 4, reservedParameters: 2 })
    const removePlan = defineD1ParameterPlan({ parametersPerItem: 1, reservedParameters: 2 })
    const setChunks = chunkD1Items(items, setPlan)
    const removeChunks = chunkD1Items(items, removePlan)

    expect(setChunks.map(chunk => chunk.length)).toEqual([24, 24, 24, 24, 4])
    expect(removeChunks.map(chunk => chunk.length)).toEqual([98, 2])
    expect(setChunks.every(chunk => chunk.length * 4 + 2 <= D1_MAX_BOUND_PARAMETERS)).toBe(true)
    expect(removeChunks.every(chunk => chunk.length + 2 <= D1_MAX_BOUND_PARAMETERS)).toBe(true)
  })

  it.each([
    { parametersPerItem: 0, reservedParameters: 0 },
    { parametersPerItem: 1.5, reservedParameters: 0 },
    { parametersPerItem: Number.NaN, reservedParameters: 0 },
    { parametersPerItem: Number.POSITIVE_INFINITY, reservedParameters: 0 },
    { parametersPerItem: 101, reservedParameters: 0 },
    { parametersPerItem: 1, reservedParameters: -1 },
    { parametersPerItem: 1, reservedParameters: 100 },
  ])('rejects an impossible parameter budget: %j', (budget) => {
    expect(() => defineD1ParameterPlan(budget)).toThrow(TypeError)
  })

  it('returns no chunks for an empty input while retaining the parsed plan', () => {
    const plan = defineD1ParameterPlan({ parametersPerItem: 1, reservedParameters: 0 })
    expect(chunkD1Items([], plan)).toEqual([])
    expect(plan.itemsPerStatement).toBe(100)
  })

  it('rejects a forged runtime plan instead of looping on an invalid size', () => {
    expect(() => chunkD1Items([1], { itemsPerStatement: 0 } as never))
      .toThrow(/defineD1ParameterPlan/)
  })

  it('asserts the emitted parameter count at the query boundary', () => {
    expect(() => assertD1BoundParameters(Array.from({ length: 100 }))).not.toThrow()
    expect(() => assertD1BoundParameters(Array.from({ length: 101 }))).toThrow(/101 bound parameters/)
    expect(() => assertD1BoundParameters('not-an-array' as never)).toThrow(/must be an array/)
  })
})

describe('getRequestD1Session', () => {
  it('creates one first-primary session per request and binding', () => {
    const session = { marker: 'session' }
    const database = { withSession: vi.fn(() => session) }
    const context = {}

    expect(getRequestD1Session(context, 'DB', database)).toBe(session)
    expect(getRequestD1Session(context, 'DB', database)).toBe(session)
    expect(database.withSession).toHaveBeenCalledOnce()
    expect(database.withSession).toHaveBeenCalledWith('first-primary')
  })
})

describe('d1 retry classification', () => {
  it('separates session resets from retryable transport failures', () => {
    expect(classifyD1RetryError(new Error('D1_ERROR: {"D1_RESET_DO":true}')))
      .toEqual({ _tag: 'session-reset' })
    expect(classifyD1RetryError(new Error('query failed', {
      cause: new Error('D1_ERROR: Replica disconnected from primary.'),
    }))).toEqual({ _tag: 'transient' })
  })
})

describe('isReplayableD1Sql', () => {
  it.each([
    'select "id" from "teams"',
    '/* drizzle */ select 1',
    'WITH recent AS (SELECT 1) SELECT * FROM recent',
    'EXPLAIN QUERY PLAN SELECT * FROM teams',
  ])('accepts a read: %s', (sql) => {
    expect(isReplayableD1Sql(sql)).toBe(true)
  })

  it.each([
    'insert into "events" ("id") values (?)',
    'update "events" set "id" = ?',
    'delete from "events" where "id" = ?',
    'WITH recent AS (SELECT 1) INSERT INTO events SELECT * FROM recent',
    'PRAGMA journal_mode = WAL',
  ])('rejects a statement that may write: %s', (sql) => {
    expect(isReplayableD1Sql(sql)).toBe(false)
  })
})

interface FakeD1Call {
  method: string
  parameters: unknown[]
  session: number
  sql: string
}

function createFakeD1(failures: unknown[]) {
  const calls: FakeD1Call[] = []
  const constraints: string[] = []
  let sessionCount = 0

  function withSession(constraint: string) {
    const session = ++sessionCount

    function execute(sql: string, parameters: unknown[], method: string) {
      calls.push({ method, parameters, session, sql })
      const error = failures.shift()
      if (error)
        return Promise.reject(error)
      return Promise.resolve({ parameters, session, sql })
    }

    function prepare(sql: string, parameters: unknown[] = []) {
      return {
        bind: (...values: unknown[]) => prepare(sql, values),
        first: () => execute(sql, parameters, 'first'),
        run: () => execute(sql, parameters, 'run'),
        all: () => execute(sql, parameters, 'all'),
        raw: () => execute(sql, parameters, 'raw'),
      }
    }

    constraints.push(constraint)
    return {
      prepare,
      batch: (statements: Array<{ all: () => unknown }>) => Promise.all(statements.map(statement => statement.all())),
      getBookmark: () => `bookmark-${session}`,
    }
  }

  return {
    calls,
    constraints,
    database: { withSession },
    sessionCount: () => sessionCount,
  }
}

describe('withD1ResetRecovery', () => {
  it('caches one recovering session per request and binding', () => {
    const d1 = createFakeD1([])
    const context = {}

    const first = getRecoveringRequestD1Session(context, 'DB', d1.database)
    const second = getRecoveringRequestD1Session(context, 'DB', d1.database)

    expect(second).toBe(first)
  })

  it('replays a bound read on a fresh session carrying the bookmark', async () => {
    const d1 = createFakeD1([new Error('D1_ERROR: {"D1_RESET_DO":true}')])
    const session = withD1ResetRecovery(d1.database, { sleep: async () => {} })

    await expect(session.prepare('select * from teams where id = ?').bind('t1').all())
      .resolves
      .toEqual({ parameters: ['t1'], session: 2, sql: 'select * from teams where id = ?' })
    expect(d1.constraints).toEqual(['first-primary', 'bookmark-1'])
    expect(d1.calls.map(call => call.session)).toEqual([1, 2])
  })

  it('does not replay a write but renews the session for the next statement', async () => {
    const reset = new Error('D1_ERROR: {"D1_RESET_DO":true}')
    const d1 = createFakeD1([reset])
    const session = withD1ResetRecovery(d1.database, { sleep: async () => {} })

    await expect(session.prepare('insert into teams (id) values (?)').bind('t1').run())
      .rejects
      .toBe(reset)
    await expect(session.prepare('select 1').all()).resolves.toMatchObject({ session: 2 })
    expect(d1.calls.map(call => call.session)).toEqual([1, 2])
  })

  it('retries a replica disconnect on the same session', async () => {
    const d1 = createFakeD1([new Error('Replica disconnected from primary.')])
    const session = withD1ResetRecovery(d1.database, { sleep: async () => {} })

    await expect(session.prepare('select 1').all()).resolves.toMatchObject({ session: 1 })
    expect(d1.sessionCount()).toBe(1)
    expect(d1.calls).toHaveLength(2)
  })

  it('rebuilds an all-read batch on the replacement session', async () => {
    const d1 = createFakeD1([new Error('D1_ERROR: {"D1_RESET_DO":true}')])
    const session = withD1ResetRecovery(d1.database, { sleep: async () => {} })

    await expect(session.batch([
      session.prepare('select 1'),
      session.prepare('select 2'),
    ])).resolves.toEqual([
      { parameters: [], session: 2, sql: 'select 1' },
      { parameters: [], session: 2, sql: 'select 2' },
    ])
    expect(d1.constraints).toEqual(['first-primary', 'bookmark-1'])
  })

  it('does not replay a batch containing a write', async () => {
    const reset = new Error('D1_ERROR: {"D1_RESET_DO":true}')
    const d1 = createFakeD1([reset])
    const session = withD1ResetRecovery(d1.database, { sleep: async () => {} })

    await expect(session.batch([
      session.prepare('select 1'),
      session.prepare('insert into events (id) values (1)'),
    ])).rejects.toBe(reset)
    expect(d1.calls.every(call => call.session === 1)).toBe(true)
  })

  it('reports whether recovery replays or stops', async () => {
    const reset = new Error('D1_ERROR: {"D1_RESET_DO":true}')
    const d1 = createFakeD1([reset])
    const events: unknown[] = []
    const session = withD1ResetRecovery(d1.database, {
      onRecovery: event => events.push(event),
      sleep: async () => {},
    })

    await expect(session.prepare('delete from teams').run()).rejects.toBe(reset)
    expect(events).toEqual([{
      _tag: 'stopped',
      attempt: 0,
      failure: { _tag: 'session-reset' },
      reason: 'unsafe-statement',
      sql: 'delete from teams',
    }])
  })

  it('stops at the attempt budget and keeps the next session healthy', async () => {
    const resets = Array.from(
      { length: 2 },
      () => new Error('D1_ERROR: {"D1_RESET_DO":true}'),
    )
    const d1 = createFakeD1(resets)
    const events: unknown[] = []
    const session = withD1ResetRecovery(d1.database, {
      maxAttempts: 2,
      onRecovery: event => events.push(event),
      sleep: async () => {},
    })

    await expect(session.prepare('select 1').all()).rejects.toThrow('D1_RESET_DO')
    await expect(session.prepare('select 2').all()).resolves.toMatchObject({ session: 3 })
    expect(events).toEqual([
      {
        _tag: 'retrying',
        attempt: 0,
        failure: { _tag: 'session-reset' },
        sql: 'select 1',
      },
      {
        _tag: 'stopped',
        attempt: 1,
        failure: { _tag: 'session-reset' },
        reason: 'attempts-exhausted',
        sql: 'select 1',
      },
    ])
  })

  it('surfaces permanent failures without retrying or reporting recovery', async () => {
    const failure = new Error('D1_ERROR: UNIQUE constraint failed: teams.id')
    const d1 = createFakeD1([failure])
    const events: unknown[] = []
    const session = withD1ResetRecovery(d1.database, {
      onRecovery: event => events.push(event),
      sleep: async () => {},
    })

    await expect(session.prepare('select 1').all()).rejects.toBe(failure)
    expect(d1.calls).toHaveLength(1)
    expect(events).toEqual([])
  })
})

describe('retryIdempotentD1Write', () => {
  it('retries only a write explicitly tagged replay-safe', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('D1_ERROR: Network connection lost'))
      .mockResolvedValue('ok')
    const sleep = vi.fn(async () => {})

    await expect(retryIdempotentD1Write({
      safety: { _tag: 'replay-safe' },
      run,
      sleep,
      random: () => 0.5,
    })).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('does not retry terminal D1 failures', async () => {
    const error = new Error('D1_ERROR: UNIQUE constraint failed')
    const run = vi.fn().mockRejectedValue(error)

    await expect(retryIdempotentD1Write({ safety: { _tag: 'replay-safe' }, run })).rejects.toBe(error)
    expect(run).toHaveBeenCalledOnce()
    expect(isTransientD1Error(error)).toBe(false)
  })

  it.each([
    'D1 DB is overloaded. Requests queued for too long.',
    'D1 DB storage operation exceeded timeout which caused object to be reset.',
    'D1 DB\'s isolate exceeded its memory limit and was reset.',
    'D1 DB exceeded its CPU time limit and was reset.',
  ])('does not amplify resource pressure by retrying: %s', async (message) => {
    const error = new Error(`D1_ERROR: ${message}`)
    const run = vi.fn().mockRejectedValue(error)

    await expect(retryIdempotentD1Write({ safety: { _tag: 'replay-safe' }, run })).rejects.toBe(error)
    expect(run).toHaveBeenCalledOnce()
    expect(isTransientD1Error(error)).toBe(false)
  })

  it('classifies mixed-case transient errors nested in a cause', () => {
    expect(isTransientD1Error(new Error('wrapper', {
      cause: new Error('D1_ERROR: NETWORK CONNECTION LOST'),
    }))).toBe(true)
  })

  it('retries a synchronous lock failure', async () => {
    const run = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('database is locked')
      })
      .mockResolvedValue('ok')

    await expect(retryIdempotentD1Write({
      safety: { _tag: 'lock-only' },
      run,
      sleep: async () => {},
    })).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('request-scoped D1 stats', () => {
  it('is reachable from the package entry, not just from inside the module', async () => {
    // 0.0.15 collected these counters and exposed no way to read them, which
    // left every consumer with no choice but to keep its own copy.
    const entry = await import('../src/d1')
    expect(typeof entry.readD1Stats).toBe('function')
    expect(typeof entry.useD1Stats).toBe('function')
    expect(typeof entry.createD1Stats).toBe('function')
  })

  it('counts queries and primary hops from what D1 reports', async () => {
    const { createD1Stats, recordD1Meta, recordD1Recovery } = await import('../src/d1')
    const stats = createD1Stats()

    recordD1Meta(stats, { meta: { served_by_primary: true, served_by_region: 'OC', duration: 1.5 } })
    recordD1Meta(stats, { meta: { served_by_primary: false, served_by_region: 'OC', duration: 0.5 } })
    // Local D1 and `wrangler dev` send no `meta` at all; still a query.
    recordD1Meta(stats, {})
    recordD1Recovery(stats, { _tag: 'retrying' })
    recordD1Recovery(stats, { _tag: 'stopped' })

    expect(stats.queries).toBe(3)
    expect(stats.primaryQueries).toBe(1)
    expect(stats.region).toBe('OC')
    expect(stats.durationMs).toBe(2)
    expect(stats.recoveries).toBe(2)
    expect(stats.unrecovered).toBe(1)
  })
})
