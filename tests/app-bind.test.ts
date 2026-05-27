import type { CfJobsRuntimeConfig } from '../src/runtime/server/app'
import { describe, expect, it, vi } from 'vitest'
import {
  createCfJobsApp,
  defineJob,
} from '../src/runtime/server/index'

const runtimeConfig: CfJobsRuntimeConfig = {
  cfJobs: { queues: { default: { binding: 'JOBS' } } },
}
const useRuntimeConfig = () => runtimeConfig

describe('createCfJobsApp (statically-injected jobs + useRuntimeConfig)', () => {
  it('exposes the materialized jobs + underlying registry', () => {
    const job = defineJob({ name: 'x', queue: 'default', handle: vi.fn() })
    const app = createCfJobsApp([job], { useRuntimeConfig })
    expect(app.jobs).toEqual([job])
    expect(app.jobRegistry.getHandler('x')).toBe(job.handle)
  })

  it('exposes registry metadata without requiring init()', () => {
    const handle = vi.fn()
    const job = defineJob({ name: 'lonely', queue: 'default', handle })
    const app = createCfJobsApp([job], { useRuntimeConfig })
    expect(app.getJobDefinition('lonely')?.name).toBe('lonely')
    expect(app.getHandler('lonely')).toBe(handle)
  })

  it('applies defaultQueue to jobs without an explicit queue', () => {
    const job = defineJob({ name: 'x', handle: vi.fn() } as never)
    const app = createCfJobsApp([job], { useRuntimeConfig, defaultQueue: 'fallback' })
    expect(app.getJobQueue('x')).toBe('fallback')
  })

  it('registerQueueConsumer registers the cloudflare:queue hook synchronously', () => {
    const app = createCfJobsApp(
      [defineJob({ name: 'x', queue: 'default', handle: vi.fn() })],
      { useRuntimeConfig },
    )
    const hooked = vi.fn()
    const nitroApp = { hooks: { hook: hooked } }

    app.registerQueueConsumer(nitroApp, { createContext: () => ({} as never) })

    expect(hooked).toHaveBeenCalledOnce()
    expect(hooked.mock.calls[0]?.[0]).toBe('cloudflare:queue')
  })

  it('validateQueueBindings pulls queues from the injected useRuntimeConfig', () => {
    const job = defineJob({ name: 'x', queue: 'default', handle: vi.fn() })
    const app = createCfJobsApp([job], { useRuntimeConfig })
    expect(() => app.validateQueueBindings()).not.toThrow()
  })
})
