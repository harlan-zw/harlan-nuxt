import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateRegistryTemplate, generateRegistryTypesTemplate } from '../src/module'

const rootDir = resolve(__dirname, 'fixtures/nuxt-demo')
const templateDir = resolve(__dirname, 'fixtures/nuxt-demo/.nuxt/cf-jobs')

const options = {
  queues: { default: 'JOBS' },
  jobsDir: 'server/jobs',
  jobsPattern: '**/*.ts',
  jobsIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
  registryAlias: '#cf-jobs/app',
} as never

describe('generateRegistryTemplate (bundled .ts, inlined into the nitro graph)', () => {
  it('imports useRuntimeConfig from nitropack/runtime', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/from\s+['"]nitropack\/runtime['"]/)
    expect(out).toContain('useRuntimeConfig')
  })

  it('statically imports every discovered job', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    // Bundled by rollup, so static imports of job sources resolve through
    // nuxt `#aliases` and extensionless paths.
    expect(out).toMatch(/^import job0 from/m)
    expect(out).toContain(`from 'nuxt-cf-jobs/server'`)
  })

  it('strips the .ts extension from job import paths', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/import job\d+ from ['"].*\.ts['"]/)
  })

  it('builds the app from a const tuple of jobs', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/export const jobs = \[.*\] as const/)
    expect(out).toMatch(/createCfJobsApp\(jobs,\s*\{/)
    expect(out).toMatch(/useRuntimeConfig,\s+defaultQueue:/)
    expect(out).toContain('registerQueueConsumer,')
    expect(out).toContain('jobRegistry,')
  })

  it('does not use the legacy lazy-loader shape or globalThis bridge', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).not.toContain('jobLoaders')
    expect(out).not.toContain('bindUseRuntimeConfig')
    expect(out).not.toContain('bindJobDefinitions')
  })
})

describe('generateRegistryTypesTemplate (.d.ts)', () => {
  it('emits type-only declarations', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/^import type /m)
    expect(out).toContain('export declare const jobs:')
    expect(out).toContain('export declare const app:')
    expect(out).toContain('export declare const registerQueueConsumer:')
    expect(out).toContain('export declare const jobRegistry:')
  })

  it('re-exports QueueConsumerOptions', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toContain('export type { QueueConsumerOptions }')
  })

  it('exports type aliases derived from the jobs tuple', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    for (const t of ['Jobs', 'JobsByName', 'JobName', 'JobDefinitionOf', 'QueueName', 'JobPayload', 'JobQueue', 'JobMessage', 'QueueMessage'])
      expect(out).toMatch(new RegExp(`export type ${t}\\b`))
    expect(out).toContain('typeof jobs')
  })

  it('job tuple entries strip the .ts extension from import paths', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/import\(".*\.ts"\)/)
    expect(out).toMatch(/typeof import\(".*"\)\['default'\]/)
  })

  it('includes a tuple entry per discovered job', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toContain('sync/table')
    expect(out).toContain('analytics/rollup-rebuild')
  })
})
