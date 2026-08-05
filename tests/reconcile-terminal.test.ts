import type { JobContext } from '#cf-jobs/server'
import { describe, expect, it, vi } from 'vitest'
import { defineJob, defineJobRegistry, runTerminalizedJobFailure } from '#cf-jobs/server'

describe('runTerminalizedJobFailure', () => {
  it('loads, parses, and runs failed after durable terminal evidence exists', async () => {
    const failed = vi.fn(async () => {})
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/stale-terminal',
        queue: 'default',
        input: {
          safeParse(input: unknown) {
            return typeof input === 'object' && input !== null && (input as { value?: unknown }).value === 42
              ? { success: true as const, data: input as { value: number } }
              : { success: false as const, error: new Error('value must be 42') }
          },
        },
        async handle() {},
        failed,
      }),
    ])
    const terminalized = {
      id: 'job-1',
      queue: 'default',
      batchId: 'batch-1',
      jobType: 'demo',
      payload: JSON.stringify({ _task: 'demo/stale-terminal', value: 42 }),
      attempts: 3,
      exception: 'stale-reservation: exhausted retries',
    }
    const createContext = vi.fn(({ control }) => ({
      env: { DB: 'available' },
      db: {},
      log: {},
      jobId: terminalized.id,
      batchId: terminalized.batchId,
      attempt: terminalized.attempts,
      release: vi.fn(),
      async fail(error: string) {
        control.handled = true
        control.action = 'failed'
        control.error = error
      },
    }) satisfies JobContext<{ DB: string }, object, object>)

    const result = await runTerminalizedJobFailure({
      env: { DB: 'available' },
      registry,
      terminalized,
      createContext,
    })

    expect(result).toEqual({ _tag: 'handled', taskName: 'demo/stale-terminal' })
    expect(createContext).toHaveBeenCalledWith(expect.objectContaining({
      env: { DB: 'available' },
      terminalized,
      taskName: 'demo/stale-terminal',
      payload: { value: 42 },
      job: expect.objectContaining({ id: 'job-1', attempts: 3 }),
    }))
    expect(failed).toHaveBeenCalledWith(
      { value: 42 },
      expect.objectContaining({ jobId: 'job-1', attempt: 3 }),
      expect.objectContaining({ message: 'stale-reservation: exhausted retries' }),
    )
  })

  it('returns visible evidence when an application context factory is absent', async () => {
    const result = await runTerminalizedJobFailure({
      env: {},
      registry: defineJobRegistry([
        defineJob({
          name: 'demo/requires-context',
          queue: 'default',
          async handle() {},
          async failed() {},
        }),
      ]),
      terminalized: {
        id: 'job-2',
        queue: 'default',
        batchId: null,
        jobType: 'demo',
        payload: JSON.stringify({ _task: 'demo/requires-context' }),
        attempts: 2,
        exception: 'exhausted',
      },
    })

    expect(result).toEqual({ _tag: 'context-unavailable', taskName: 'demo/requires-context' })
  })
})
