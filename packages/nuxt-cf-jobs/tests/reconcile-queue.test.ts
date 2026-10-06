import type { DurableJobRecord, SettleBatchMemberOptions } from '#cf-jobs/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import reconcile from '../src/runtime/server/tasks/reconcile'

const state = vi.hoisted(() => ({
  queue: undefined as string | undefined,
  records: [] as DurableJobRecord[],
  sendInteractive: vi.fn(async () => {}),
  sendDefault: vi.fn(async () => {}),
}))

vi.mock('@harlan-zw/nuxt-cloudflare/bindings', () => ({
  resolveCloudflareBindings: () => ({
    DB: { prepare: () => ({ first: async () => 1 }), exec: async () => {} },
    QUEUE_INTERACTIVE: { send: state.sendInteractive },
    QUEUE_DEFAULT: { send: state.sendDefault },
  }),
}))
vi.mock('#cf-jobs/app', () => ({
  jobRegistry: { getJobRoute: () => ({ queue: 'default', jobType: 'finish' }) },
}))
vi.mock('#cf-jobs/reconcile-context', () => ({ createReconcileJobContext: undefined }))
vi.mock('#nuxt-cf-jobs/nitro', () => ({
  useRuntimeConfig: () => ({ cfJobs: { queues: { interactive: 'QUEUE_INTERACTIVE', default: 'QUEUE_DEFAULT' } } }),
}))
vi.mock('../src/runtime/server/d1', () => ({
  createD1DurableJobRepository: () => ({
    async insertJob(record: DurableJobRecord) {
      state.records.push(record)
      return true
    },
  }),
}))
vi.mock('../src/runtime/server/recovery', () => ({
  recoverDurableJobs: async () => ({ released: 0, terminalized: 0, terminalizedJobs: [], swept: 0, dispatched: 0 }),
}))
vi.mock('../src/runtime/server/batch', () => ({
  createD1DurableBatchStore: () => ({}),
  settleBatchMember: async () => {},
  async recoverOrphanedBatches({ dispatchOnFinish }: { dispatchOnFinish: NonNullable<SettleBatchMemberOptions['dispatchOnFinish']> }) {
    await dispatchOnFinish({
      continuation: { name: 'demo/finish', payload: { value: 42 }, queue: state.queue },
      batch: { id: 'batch-1' } as Parameters<typeof dispatchOnFinish>[0]['batch'],
    })
    return { recovered: 1, scanned: 1, skipped: 0, onFinishDispatched: 1, onFinishFailed: 0, unrecoverable: 0, errors: [] }
  },
}))

describe('scheduled batch recovery', () => {
  beforeEach(() => {
    state.records.length = 0
    vi.clearAllMocks()
  })

  it.each([
    { persisted: 'interactive', expected: 'interactive' },
    { persisted: undefined, expected: 'default' },
  ])('dispatches a recovered continuation to $expected', async ({ persisted, expected }) => {
    state.queue = persisted
    await reconcile.run({ payload: {}, context: {} })

    expect(state.records).toEqual([expect.objectContaining({ queue: expected, jobType: 'finish' })])
    const selected = expected === 'interactive' ? state.sendInteractive : state.sendDefault
    const other = expected === 'interactive' ? state.sendDefault : state.sendInteractive
    expect(selected).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
  })
})
