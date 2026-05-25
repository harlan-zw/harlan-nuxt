import { describe, expect, it, vi } from 'vitest'
import {
  buildJobPayload,
  createDevQueueRuntime,
  defineJob,
  defineJobRegistry,
  processRegisteredQueueBatch,
} from '../src/runtime/server'

describe('createDevQueueRuntime', () => {
  it('injects an in-memory queue binding and drains via the cloudflare:queue hook', async () => {
    const handled: string[] = []
    const registry = defineJobRegistry([
      defineJob({
        name: 'dev/echo',
        queue: 'default',
        async handle(payload: { msg: string }) {
          handled.push(payload.msg)
        },
      }),
    ])

    const batches: unknown[] = []
    const runtime = createDevQueueRuntime({
      queues: { default: 'JOBS' },
      onBatch: async (payload) => {
        batches.push(payload)
        await processRegisteredQueueBatch(payload as never, {
          registry,
          queues: { default: 'JOBS' },
          createContext: ({ control, job, message }) => ({
            env: payload.env as Record<string, unknown>,
            db: null,
            log: console,
            jobId: job.id,
            batchId: null,
            attempt: job.attempts,
            async release(delaySeconds: number) {
              control.handled = true
              control.action = 'released'
              control.delaySeconds = delaySeconds
              message.retry({ delaySeconds })
            },
            async fail(error: string) {
              control.handled = true
              control.action = 'failed'
              control.error = error
              message.ack()
            },
          }),
        })
      },
    })

    expect(runtime.env.JOBS).toBeDefined()
    const queue = runtime.env.JOBS as { send: (m: unknown) => Promise<void> }

    await queue.send(buildJobPayload('dev/echo', { msg: 'hello' }))
    await queue.send(buildJobPayload('dev/echo', { msg: 'world' }))

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(handled).toEqual(['hello', 'world'])
    expect(batches).toHaveLength(2)
    runtime.dispose()
  })

  it('respects delaySeconds before draining', async () => {
    vi.useFakeTimers()
    const onBatch = vi.fn()
    const runtime = createDevQueueRuntime({
      queues: { default: 'JOBS' },
      onBatch,
    })
    const queue = runtime.env.JOBS as { send: (m: unknown, opts?: { delaySeconds?: number }) => Promise<void> }

    await queue.send({ _task: 'noop' }, { delaySeconds: 5 })
    await vi.advanceTimersByTimeAsync(0)
    expect(onBatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onBatch).toHaveBeenCalledTimes(1)

    runtime.dispose()
    vi.useRealTimers()
  })

  it('retries up to maxAttempts when message.retry() is called', async () => {
    const calls: number[] = []
    const runtime = createDevQueueRuntime({
      queues: { default: 'JOBS' },
      maxAttempts: 3,
      onBatch: async ({ batch }) => {
        const message = batch.messages[0]!
        calls.push(message.attempts)
        message.retry()
      },
    })
    const queue = runtime.env.JOBS as { send: (m: unknown) => Promise<void> }
    await queue.send({ _task: 'noop' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toEqual([1, 2, 3])
    runtime.dispose()
  })
})
