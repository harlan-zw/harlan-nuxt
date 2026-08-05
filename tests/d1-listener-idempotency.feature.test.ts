import type { D1DatabaseLike, D1PreparedStatementLike } from 'nuxt-cf-jobs/outbox'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createD1ListenerIdempotencyAdapter } from '../../../layers/saas/server/utils/event-listener-idempotency'

function createSqliteD1(): D1DatabaseLike & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE api_idempotency_entries (
      idempotency_key text PRIMARY KEY,
      status text NOT NULL,
      lease_id text,
      started_at integer NOT NULL,
      expires_at integer NOT NULL,
      result text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `)
  return {
    sqlite,
    async exec(query: string) {
      sqlite.exec(query)
    },
    prepare<Output = unknown>(query: string): D1PreparedStatementLike<Output> {
      const statement = sqlite.prepare(query)
      let values: unknown[] = []
      const prepared: D1PreparedStatementLike<Output> = {
        bind(...input: unknown[]) {
          values = input
          return prepared
        },
        async run() {
          const result = statement.run(...(values as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        },
        async first<Result = Output>() {
          return (statement.get(...(values as never[])) ?? null) as Result | null
        },
        async all<Result = Output>() {
          return { results: statement.all(...(values as never[])) as Result[] }
        },
      }
      return prepared
    },
  }
}

const identity = {
  key: 'welcome:user-1',
  deliveryId: 'delivery-1',
  eventId: 'event-1',
  eventName: 'pro:onboarding:completed',
  listenerName: 'onboarding-completed-queue-drip',
}

describe('d1 queued listener idempotency', () => {
  it('persists completion and suppresses a duplicate delivery', async () => {
    const d1 = createSqliteD1()
    const adapter = createD1ListenerIdempotencyAdapter(d1)
    const effect = vi.fn(async () => 'sent')

    await expect(adapter.run(identity, effect)).resolves.toEqual({ _tag: 'executed', value: 'sent' })
    await expect(adapter.run(identity, effect)).resolves.toEqual({ _tag: 'duplicate' })

    expect(effect).toHaveBeenCalledOnce()
    const completed = d1.sqlite.prepare('SELECT status, lease_id, result FROM api_idempotency_entries').get() as { status: string, lease_id: string | null, result: string }
    expect(completed).toMatchObject({
      status: 'complete',
      lease_id: null,
    })
    expect(JSON.parse(completed.result)).toEqual(expect.objectContaining({
      deliveryId: identity.deliveryId,
      eventId: identity.eventId,
      listenerName: identity.listenerName,
    }))
  })

  it('releases a failed attempt so cf-jobs can retry the listener', async () => {
    const d1 = createSqliteD1()
    const adapter = createD1ListenerIdempotencyAdapter(d1)
    const effect = vi.fn()
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce('sent')

    await expect(adapter.run(identity, effect)).rejects.toThrow('provider failed')
    await expect(adapter.run(identity, effect)).resolves.toEqual({ _tag: 'executed', value: 'sent' })

    expect(effect).toHaveBeenCalledTimes(2)
  })

  it('rejects a concurrent pending claim without executing twice', async () => {
    const d1 = createSqliteD1()
    const adapter = createD1ListenerIdempotencyAdapter(d1)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = adapter.run(identity, () => held)

    await expect(adapter.run(identity, vi.fn())).rejects.toMatchObject({ _tag: 'ListenerIdempotencyInProgress' })
    release()
    await first
  })

  it('rejects an empty listener key and timestamps completion after the effect', async () => {
    const d1 = createSqliteD1()
    const now = vi.fn()
      .mockReturnValueOnce(new Date('2026-08-05T00:00:00.000Z'))
      .mockReturnValueOnce(new Date('2026-08-05T00:01:00.000Z'))
    const adapter = createD1ListenerIdempotencyAdapter(d1, { now, ttlSeconds: 300 })

    await expect(adapter.run({ ...identity, key: '   ' }, vi.fn())).rejects.toThrow(/non-empty key/)
    await adapter.run(identity, async () => undefined)

    expect(d1.sqlite.prepare('SELECT expires_at, updated_at FROM api_idempotency_entries').get()).toEqual({
      expires_at: 1_785_888_360,
      updated_at: 1_785_888_060,
    })
  })
})
