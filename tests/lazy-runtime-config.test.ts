import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCfJobsApp, defineJob } from '../src/runtime/server'
import { provideJobRuntimeConfig } from '../src/runtime/server/runtime-config'

describe('lazy generated registry runtime config', () => {
  it('uses the shared runtime config provider without app-local injection', () => {
    provideJobRuntimeConfig(() => ({
      cfJobs: { queues: { default: { binding: 'JOBS' } } },
    }) as never)
    const app = createCfJobsApp([
      defineJob({ name: 'lazy-config', queue: 'default', handle: vi.fn() }),
    ])

    expect(app.validateQueueBindings()).toEqual([])
  })

  it('does not import the generated registry from the startup plugin', () => {
    const plugin = readFileSync(resolve(import.meta.dirname, '../src/runtime/server/plugins/provide-runtime-config.ts'), 'utf8')

    expect(plugin).not.toContain('from \'#cf-jobs/app\'')
    expect(plugin).toContain('provideJobRuntimeConfig(useRuntimeConfig)')
  })
})
