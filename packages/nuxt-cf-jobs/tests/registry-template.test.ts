import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildRegistryPlan, collectRegistrySources, createRegistrySourceTracker, generateRegistryTemplate, generateRegistryTypesTemplate, inlineRegistryTemplateInNitroDev } from '../src/build/registry'

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
  it('includes lazy sources contributed by another Nuxt module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-jobs-source-'))
    mkdirSync(join(root, 'server/jobs'), { recursive: true })
    mkdirSync(join(root, 'module-runtime'), { recursive: true })
    writeFileSync(join(root, 'server/jobs/local.ts'), `export default defineJob({ name: 'local', queue: 'default', handle() {} })`)
    const contributed = join(root, 'module-runtime/deliver-event-listener.ts')
    writeFileSync(contributed, `export default defineJob({ name: 'events/deliver-listener', queue: 'events', handle() {} })`)

    const plan = await buildRegistryPlan(options, root, join(root, '.nuxt/cf-jobs'), [{ file: contributed }])

    expect(plan.entries.map(entry => entry.name)).toEqual(['local', 'events/deliver-listener'])
    expect(plan.entries[1]?.importPath).toContain('module-runtime/deliver-event-listener')
  })

  it('collects registry sources through a late-bound Nuxt hook', async () => {
    const callHook = vi.fn(async (_name: string, context: { sources: unknown[] }) => {
      context.sources.push({ file: '/module/job.ts' })
    })

    await expect(collectRegistrySources({ callHook } as never)).resolves.toEqual([{ file: '/module/job.ts' }])
    expect(callHook).toHaveBeenCalledWith('cf-jobs:registry:sources', { sources: [{ file: '/module/job.ts' }] })
  })

  it('uses a contributed name override for an auto-discovered file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-jobs-source-override-'))
    const file = join(root, 'server/jobs/local.ts')
    mkdirSync(join(root, 'server/jobs'), { recursive: true })
    writeFileSync(file, `export default defineJob({ name: 'local', queue: 'default', handle() {} })`)

    const plan = await buildRegistryPlan(options, root, join(root, '.nuxt/cf-jobs'), [{ file, name: 'module/override' }])

    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]?.name).toBe('module/override')
  })

  it('remembers a contributed source long enough to invalidate its deletion', async () => {
    const file = '/module/deleted-job.ts'
    let sources = [{ file }]
    const callHook = vi.fn(async (_name: string, context: { sources: Array<{ file: string }> }) => {
      context.sources.push(...sources)
    })
    const tracker = createRegistrySourceTracker({ callHook } as never)
    await tracker.collect()
    sources = []

    await expect(tracker.isWatched(file, '/app')).resolves.toBe(true)
    await expect(tracker.isWatched('/module/unrelated.ts', '/app')).resolves.toBe(false)
  })

  it('defers runtime config access and imports only the focused app factory', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    // The registry loads in raw Node and Vite contexts, so it must NOT import
    // `nitropack/runtime` (drags `internal/storage.mjs` → unresolved
    // `#nitro-internal-virtual/storage`) nor `#imports` (a build-only Nuxt
    // virtual). Nitro aliases the focused runtime config adapter only when this
    // registry enters its graph; raw Node resolves the safe package fallback.
    expect(out).not.toMatch(/from\s+['"]nitropack\/runtime['"]/)
    expect(out).not.toMatch(/from\s+['"]#imports['"]/)
    expect(out).toContain(`from '@harlan-zw/nuxt-cf-jobs/runtime-config'`)
    expect(out).toContain('event => useJobRuntimeConfig(event)')
    expect(out).toContain(`from '@harlan-zw/nuxt-cf-jobs/app'`)
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

  it('builds the app from a lazy metadata array and re-exports the facade', async () => {
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).toMatch(/export const jobs = \[/)
    expect(out).not.toContain('as const')
    expect(out).toContain('@type {import(\'@harlan-zw/nuxt-cf-jobs/server\').CfJobsApp<readonly [')
    expect(out).toMatch(/createGeneratedCfJobsApp\(jobs,\s*\{/)
    // Every facade helper (incl. loadJobDefinition) is destructured straight off
    // the runtime app — no hand-written typed wrapper.
    expect(out).toContain('} = app')
    expect(out).toContain('loadJobDefinition,')
    expect(out).toContain('registerQueueConsumer,')
    expect(out).toContain('createDurableRuntime,')
    expect(out).toContain('jobRegistry,')
  })

  it('emits plain JavaScript only (no TypeScript syntax)', async () => {
    // The registry is a generated runtime module; TS syntax here breaks builds
    // whose buildDir lives under node_modules (esbuild skips node_modules, so the
    // .ts reaches rollup untranspiled). Type precision must stay in comments or .d.ts.
    const out = await generateRegistryTemplate(options, rootDir, templateDir)
    expect(out).not.toContain('import type')
    expect(out).not.toMatch(/^type \w/m)
    expect(out).not.toContain(' as unknown as ')
    expect(out).not.toMatch(/:\s*Promise</)
    expect(out).not.toMatch(/<Name extends/)
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
    expect(out).toMatch(/declare module ["']#cf-jobs\/app["'] \{/)
    // Runtime values come from the plain JS template; precision is added with
    // JSDoc on `app`, not value re-declarations in the augmentation.
    expect(out).not.toContain('export declare const jobs')
    expect(out).not.toContain('export declare const app')
  })

  it('re-exports app helper option types from the augmentation', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).toContain(`export type { CfJobsDurableRuntimeOptions, QueueConsumerOptions } from '@harlan-zw/nuxt-cf-jobs/server'`)
  })

  it('exports type aliases derived from the full job def tuple', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    for (const t of ['JobName', 'JobDefinitionOf', 'QueueName', 'JobPayload', 'JobQueue', 'JobMessage', 'QueueMessage', 'JobBroadcastMessage', 'JobBroadcastEnvelope', 'BroadcastMessage', 'BroadcastEnvelope'])
      expect(out).toMatch(new RegExp(`export type ${t}\\b`))
    expect(out).toMatch(/typeof import\(".*"\)\['default'\]/)
  })

  it('tuple entries strip the .ts extension and include every job', async () => {
    const out = await generateRegistryTypesTemplate(options, rootDir, templateDir)
    expect(out).not.toMatch(/import\(".*\.ts"\)/)
    expect(out).toContain('sync/table')
    expect(out).toContain('analytics/rollup-rebuild')
  })

  it('augments a custom registryAlias as well as the plugin-required default alias', async () => {
    const out = await generateRegistryTypesTemplate({ ...options, registryAlias: '#my/jobs' } as never, rootDir, templateDir)
    expect(out).toMatch(/declare module ["']#cf-jobs\/app["'] \{/)
    expect(out).toMatch(/declare module ["']#my\/jobs["'] \{/)
  })

  it('strips TS-family source extensions from value and type imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-jobs-ext-'))
    mkdirSync(join(root, 'server/jobs'), { recursive: true })
    writeFileSync(join(root, 'server/jobs/a.mts'), `export default defineJob({ name: 'a', queue: 'default', handle() {} })`)
    writeFileSync(join(root, 'server/jobs/b.tsx'), `export default defineJob({ name: 'b', queue: 'default', handle() {} })`)
    const opts = { ...options, jobsPattern: '**/*.{mts,tsx}' } as never

    const value = await generateRegistryTemplate(opts, root, join(root, '.nuxt/cf-jobs'))
    const types = await generateRegistryTypesTemplate(opts, root, join(root, '.nuxt/cf-jobs'))

    expect(value).not.toMatch(/import\(".*\.(?:mts|tsx)"\)/)
    expect(types).not.toMatch(/import\(".*\.(?:mts|tsx)"\)/)
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

  it('surfaces job source read failures instead of generating fallback metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-jobs-unreadable-'))
    const jobsDir = join(root, 'server/jobs')
    const file = join(jobsDir, 'unreadable.ts')
    mkdirSync(jobsDir, { recursive: true })
    writeFileSync(file, `export default defineJob({ name: 'unreadable', queue: 'default', handle() {} })`)
    chmodSync(file, 0o000)

    try {
      await expect(generateRegistryTemplate(options, root, join(root, '.nuxt/cf-jobs')))
        .rejects
        .toThrow(file)
    }
    finally {
      chmodSync(file, 0o600)
    }
  })
})

describe('inlineRegistryTemplateInNitroDev', () => {
  it('inlines the generated registry in Nitro dev even when rollup resolves it as a file URL', () => {
    const registryPath = '/tmp/app/.nuxt/cf-jobs/registry.js'
    const existingInline = /node_modules\/already-inline/
    const nuxt = {
      options: {
        dev: true,
        nitro: {
          externals: {
            inline: [existingInline],
          },
        },
      },
    }

    inlineRegistryTemplateInNitroDev(nuxt as never, registryPath)

    const inline = nuxt.options.nitro.externals.inline
    expect(inline[0]).toBe(existingInline)
    const matcher = inline[1] as (id: string) => boolean
    expect(matcher(registryPath)).toBe(true)
    expect(matcher('file:///tmp/app/.nuxt/cf-jobs/registry.js')).toBe(true)
    expect(matcher('file:///tmp/app/.nuxt/cf-jobs/other.js')).toBe(false)
  })

  it('does not mutate Nitro externals outside dev', () => {
    const nuxt = {
      options: {
        dev: false,
      },
    }

    inlineRegistryTemplateInNitroDev(nuxt as never, '/tmp/app/.nuxt/cf-jobs/registry.js')

    expect(nuxt.options).not.toHaveProperty('nitro')
  })
})
