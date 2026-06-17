import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateRegistryTemplate, generateRegistryTypesTemplate } from '../src/build/registry'

const rootDir = resolve(__dirname, 'fixtures/nuxt-demo')
const templateDir = resolve(__dirname, 'fixtures/nuxt-demo/.nuxt/cf-jobs')

const options = {
  queues: { default: 'JOBS' },
  jobsDir: 'server/jobs',
  jobsPattern: '**/*.ts',
  jobsIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
  registryAlias: '#cf-jobs/app',
} as never

describe('generateRegistryTemplate (data-only lazy registry)', () => {
  it('imports useRuntimeConfig from nitropack/runtime + the app factory', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/from\s+['"]nitropack\/runtime['"]/)
    expect(out).toContain('useRuntimeConfig')
    expect(out).toContain(`from 'nuxt-cf-jobs/server'`)
  })

  it('does NOT statically import job handlers (they load lazily)', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/^import job\d+ from/m)
    // Each entry carries a lazy dynamic-import loader instead.
    expect(out).toMatch(/load: \(\) => import\(/)
    expect(out).toContain(`.then(m => m.default)`)
  })

  it('strips the .ts extension from lazy import paths', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/import\(".*\.ts"\)/)
  })

  it('builds the app from a lazy metadata array and types the exported facade', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/export const jobs = \[/)
    expect(out).not.toContain('as const')
    expect(out).toMatch(/createGeneratedCfJobsApp\(jobs,\s*useRuntimeConfig,/)
    expect(out).toContain(`import type { CfJobsApp } from 'nuxt-cf-jobs/server'`)
    expect(out).toContain('const typedApp = app as unknown as CfJobsApp<Jobs>')
    expect(out).toContain('export function loadJobDefinition<Name extends LocalJobName>')
    expect(out).toContain('} = typedApp')
    expect(out).toContain('registerQueueConsumer,')
    expect(out).toContain('createDurableRuntime,')
    expect(out).toContain('jobRegistry,')
  })

  it('inlines AST-extracted routing metadata (name + literal queue)', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toContain(`name: "sync/table"`)
    expect(out).toContain(`queue: "default"`)
    expect(out).toContain(`name: "analytics/rollup-rebuild"`)
    expect(out).toContain(`queue: "analytics"`)
  })

  it('keys the entry by the declared defineJob name, falling back to the file path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-jobs-name-'))
    mkdirSync(join(root, 'server/jobs'), { recursive: true })
    // Declared name differs from the file path; a sibling omits `name`.
    writeFileSync(join(root, 'server/jobs/reconcile-stripe-customer.ts'), `export default defineJob({ name: 'pro:reconcile-stripe-customer', queue: 'default', handle() {} })`)
    writeFileSync(join(root, 'server/jobs/plain.ts'), `export default defineJob({ queue: 'default', handle() {} })`)

    const out = await generateRegistryTemplate(options, root, join(root, '.nuxt/cf-jobs'))
    expect(out).toContain(`name: "pro:reconcile-stripe-customer"`)
    expect(out).not.toContain(`name: "reconcile-stripe-customer"`)
    expect(out).toContain(`name: "plain"`)
  })

  it('does not use the legacy lazy-loader shape or globalThis bridge', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).not.toContain('jobLoaders')
    expect(out).not.toContain('bindUseRuntimeConfig')
    expect(out).not.toContain('bindJobDefinitions')
  })
})

describe('generateRegistryTypesTemplate (#cf-jobs/app augmentation)', () => {
  it('augments the resolved module rather than re-declaring it', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/^import type /m)
    expect(out).toContain(`declare module '#cf-jobs/app' {`)
    // No standalone value re-declarations — those come from the runtime .ts.
    expect(out).not.toContain('export declare const jobs')
    expect(out).not.toContain('export declare const app')
  })

  it('re-exports app helper option types from the augmentation', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toContain(`export type { CfJobsDurableRuntimeOptions, QueueConsumerOptions } from 'nuxt-cf-jobs/server'`)
  })

  it('exports type aliases derived from the full job def tuple', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    for (const t of ['JobName', 'JobDefinitionOf', 'QueueName', 'JobPayload', 'JobQueue', 'JobMessage', 'QueueMessage'])
      expect(out).toMatch(new RegExp(`export type ${t}\\b`))
    expect(out).toMatch(/typeof import\(".*"\)\['default'\]/)
  })

  it('tuple entries strip the .ts extension and include every job', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/import\(".*\.ts"\)/)
    expect(out).toContain('sync/table')
    expect(out).toContain('analytics/rollup-rebuild')
  })

  it('uses the same duplicate-name guard as the value module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-jobs-dupes-'))
    mkdirSync(join(root, 'server/jobs'), { recursive: true })
    writeFileSync(join(root, 'server/jobs/a.ts'), `export default defineJob({ name: 'same', queue: 'default', handle() {} })`)
    writeFileSync(join(root, 'server/jobs/b.ts'), `export default defineJob({ name: 'same', queue: 'default', handle() {} })`)

    await expect(generateRegistryTypesTemplate(options, root, join(root, '.nuxt/cf-jobs')))
      .rejects
      .toThrow('Duplicate nuxt-cf-jobs generated job names')
  })
})
