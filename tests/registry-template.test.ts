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

describe('generateRegistryTemplate (runtime .mjs)', () => {
  it('emits pure JS with no TypeScript syntax', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/\bas const\b/)
    expect(out).not.toMatch(/\bas never\b/)
    expect(out).not.toMatch(/^export type /m)
    expect(out).not.toMatch(/^import type /m)
    expect(out).not.toMatch(/^export type \{/m)
  })

  it('includes runtime exports', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toContain(`import { createCfJobsApp } from '#cf-jobs/server'`)
    expect(out).toContain('export const jobLoaders = {')
    expect(out).toContain('export const jobs = [')
    expect(out).toContain('export const app = createCfJobsApp(jobs, useRuntimeConfig,')
    expect(out).toContain('export const jobRegistry = app.jobRegistry')
    expect(out).toContain('registerQueueConsumer,')
  })

  it('passes useRuntimeConfig without `as never` cast', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toContain('createCfJobsApp(jobs, useRuntimeConfig,')
  })
})

describe('generateRegistryTypesTemplate (.d.ts)', () => {
  it('emits type-only declarations', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/^import type /m)
    expect(out).toContain('export declare const jobLoaders:')
    expect(out).toContain('export declare const jobs: readonly unknown[]')
    expect(out).toContain('export declare const app:')
    expect(out).toContain('export declare const jobRegistry:')
    expect(out).toContain('export declare const registerQueueConsumer:')
  })

  it('re-exports QueueConsumerOptions', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toContain('QueueConsumerOptions')
    expect(out).toContain('export type { QueueConsumerOptions }')
  })

  it('exports type aliases derived from the jobs registry', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    for (const t of ['Jobs', 'JobsByName', 'JobName', 'JobDefinitionOf', 'QueueName', 'JobPayload', 'JobQueue', 'JobMessage', 'QueueMessage'])
      expect(out).toMatch(new RegExp(`export type ${t}\\b`))
  })

  it('loader entries strip the .ts extension from import paths', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/import\(".*\.ts"\)/)
    expect(out).toMatch(/Promise<typeof import\(".*"\)\['default'\]>/)
  })

  it('includes a loader entry per discovered job', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toContain('"sync/table"')
    expect(out).toContain('"analytics/rollup-rebuild"')
  })
})
