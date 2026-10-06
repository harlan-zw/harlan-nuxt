import type { DurableJobRecord, SettleBatchMemberOptions } from '#cf-jobs/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import reconcile from '../src/runtime/server/tasks/reconcile'

const state = vi.hoisted(() => ({
  queue: undefined as string | undefined,
  definitionOnly: false,
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
  jobRegistry: {
    getJobRoute: () => state.definitionOnly ? undefined : ({ queue: 'default', jobType: 'finish' }),
    getJobDefinition: () => ({ queue: 'default', jobType: 'finish-definition', handle: async () => {} }),
  },
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
    { persisted: 'interactive', expected: 'interactive', definitionOnly: false },
    { persisted: undefined, expected: 'default', definitionOnly: false },
    { persisted: 'interactive', expected: 'interactive', definitionOnly: true },
    { persisted: undefined, expected: 'default', definitionOnly: true },
  ])('dispatches a recovered continuation to $expected, definitionOnly=$definitionOnly', async ({ persisted, expected, definitionOnly }) => {
    state.queue = persisted
    state.definitionOnly = definitionOnly
    await reconcile.run({ payload: {}, context: {} })

    expect(state.records).toEqual([expect.objectContaining({ queue: expected, jobType: definitionOnly ? 'finish-definition' : 'finish' })])
    const selected = expected === 'interactive' ? state.sendInteractive : state.sendDefault
    const other = expected === 'interactive' ? state.sendDefault : state.sendInteractive
    expect(selected).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
  })
})
