import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions } from './types'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { addServerImports, addServerPlugin, addTemplate, addTypeTemplate, createResolver, defineNuxtModule, resolveFiles, updateTemplates, useLogger } from '@nuxt/kit'
import { extractJobMeta } from './build/extract-job-meta'
import { cfJobsAppExportNames } from './runtime/server/app'
import { buildCronUnion, buildScheduledTasks, collectTasks, findDuplicateTaskNames } from './tasks'
import {
  crossCheckCrons,
  findWranglerConfig,
  parseWranglerConfig,
  reconcileQueues,
  renderSuggestedCronsToml,
} from './wrangler'

export type { ModuleOptions } from './types'

declare module '@nuxt/schema' {
  interface RuntimeConfig {
    cfJobs: { queues: ModuleOptions['queues'], defaultQueue?: string }
  }
}

const TS_EXTENSION_RE = /\.ts$/
const WINDOWS_SLASH_RE = /\\/g
const JOB_FILE_EXTENSION_RE = /\.[cm]?tsx?$/
const INDEX_ROUTE_RE = /\/index$/

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-cf-jobs',
    configKey: 'cfJobs',
  },
  defaults: {
    queues: {},
    jobsDir: 'server/jobs',
    jobsPattern: '**/*.ts',
    jobsIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    // tasksDir is opt-in: scanning + registering tasks mutates nitro.tasks /
    // scheduledTasks / triggers.crons, so it only runs when explicitly set.
    tasksPattern: '**/*.ts',
    tasksIgnore: ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    registryAlias: '#cf-jobs/app',
  },
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    nuxt.options.alias['#cf-jobs/server'] = resolver.resolve('./runtime/server')
    // Cloudflare Analytics Engine sink lives on its own subpath so its
    // Workers-specific `writeDataPoint` shape never loads with the core barrel.
    nuxt.options.alias['#cf-jobs/cloudflare'] = resolver.resolve('./runtime/server/cloudflare')
    addServerImports([
      { name: 'defineJob', from: resolver.resolve('./runtime/server/registry') },
      { name: 'defineScheduledTask', from: resolver.resolve('./runtime/server/scheduled') },
    ])
    // Data-only runtime `.ts`: the registry value module the `#cf-jobs/app`
    // alias resolves to. It holds AST-extracted routing metadata + lazy
    // `load()` thunks and the app wiring — no hand-written types.
    const registryTemplate = addTemplate({
      filename: 'cf-jobs/registry.ts',
      write: true,
      getContents: async () => generateRegistryTemplate(options, nuxt.options.rootDir, resolve(nuxt.options.buildDir, 'cf-jobs')),
    })
    nuxt.options.alias[options.registryAlias ?? '#cf-jobs/app'] = registryTemplate.dst

    // Types are emitted as a separate `declare module '#cf-jobs/app'`
    // augmentation: a sibling `registry.d.ts` would be shadowed by the `.ts`
    // (TS resolves `.ts` over `.d.ts`), but an augmentation MERGES into the
    // resolved module, so the type-only aliases (`JobName`, `JobPayload`, …)
    // become importable from `#cf-jobs/app` without touching the value module.
    const typesTemplate = addTypeTemplate({
      filename: 'cf-jobs/registry-augmentation.d.ts',
      getContents: async () => generateRegistryTypesTemplate(options, nuxt.options.rootDir, resolve(nuxt.options.buildDir, 'cf-jobs')),
    }, { nuxt: true, nitro: true })

    nuxt.hooks.hook('builder:watch' as never, (async (_event: string, path: string) => {
      if (!isWatchedJobPath(path, options, nuxt.options.rootDir))
        return
      // HMR: a job file edit can change AST-extracted metadata (queue, etc.) and
      // the derived types, so refresh both the value module and the augmentation.
      await updateTemplates({ filter: template => template.dst === registryTemplate.dst || template.dst === typesTemplate.dst })
    }) as never)

    if (options.defaultQueue && !options.queues[options.defaultQueue])
      useLogger('nuxt-cf-jobs').warn(`cfJobs.defaultQueue="${options.defaultQueue}" is not a key of cfJobs.queues`)

    nuxt.options.runtimeConfig.cfJobs = {
      ...(nuxt.options.runtimeConfig.cfJobs ?? {}),
      queues: nuxt.options.runtimeConfig.cfJobs?.queues ?? options.queues,
      defaultQueue: nuxt.options.runtimeConfig.cfJobs?.defaultQueue ?? options.defaultQueue,
    }

    if (nuxt.options.dev)
      addServerPlugin(resolver.resolve('./runtime/server/plugins/dev-queues'))

    if (options.validateWrangler !== false)
      runWranglerCrossCheck(options, nuxt.options.rootDir, resolve(nuxt.options.buildDir, 'cf-jobs'), (nuxt.options as { nitro?: unknown }).nitro)

    await wireScheduledTasks(options, nuxt, resolve(nuxt.options.buildDir, 'cf-jobs'))
  },
})

/**
 * Discover `defineScheduledTask` / `defineTask` files under `tasksDir`, register
 * their handlers in `nitro.tasks`, derive `nitro.scheduledTasks` + the wrangler
 * `triggers.crons` union from co-located crons, and cross-check an external
 * wrangler file. Replaces hand-maintaining all three lists in `nuxt.config`.
 */
async function wireScheduledTasks(options: ModuleOptions, nuxt: Nuxt, templateDir: string): Promise<void> {
  if (!options.tasksDir)
    return

  const logger = useLogger('nuxt-cf-jobs')
  const rootDir = nuxt.options.rootDir
  const tasksDir = resolveTaskDirs(options.tasksDir, nuxt)
  const { tasks, unnamed } = await collectTasks({ ...options, tasksDir }, rootDir)

  for (const file of unnamed)
    logger.warn(`nuxt-cf-jobs: task at ${relative(rootDir, file)} declares a cron but no statically-readable string-literal \`name\` — skipped.`)

  if (tasks.length === 0)
    return

  const dupes = findDuplicateTaskNames(tasks)
  if (dupes.length > 0)
    throw new Error(`Duplicate nuxt-cf-jobs task names: ${dupes.join(', ')}`)

  // `nitro.cloudflare.*` and `nitro.tasks` aren't on the public Nuxt nitro type
  // surface here; the module already casts nitro options elsewhere.
  const nitro = ((nuxt.options as { nitro?: Record<string, any> }).nitro ??= {})

  // 1. Register every discovered task handler — replaces the hand-maintained
  //    `nitro.tasks` map. Name comes from the file's declared `name`.
  nitro.tasks ??= {}
  for (const t of tasks) {
    const existing = nitro.tasks[t.name] as { handler?: string } | undefined
    if (existing && existing.handler && existing.handler !== t.handler)
      logger.warn(`nuxt-cf-jobs: task "${t.name}" already registered (${existing.handler}) — overriding with ${relative(rootDir, t.file)}.`)
    nitro.tasks[t.name] = { ...existing, handler: t.handler }
  }

  // 2. Cron schedule. Gated off in dev by default so crons don't fire locally
  //    (mirrors the common `NODE_ENV === 'production' ? {...} : {}` pattern).
  const scheduled = tasks.filter(t => t.crons.length > 0)
  const cronUnion = buildCronUnion(tasks)
  const enableSchedule = options.scheduledTasks ?? !nuxt.options.dev
  if (enableSchedule && scheduled.length > 0)
    nitro.scheduledTasks = buildScheduledTasks(tasks, (nitro.scheduledTasks ?? {}) as Record<string, string[]>)

  // 3. Cloudflare cron triggers — always written (deploy-only metadata). This is
  //    the list that silently drifts from scheduledTasks when hand-maintained.
  if (cronUnion.length > 0) {
    nitro.cloudflare ??= {}
    nitro.cloudflare.wrangler ??= {}
    nitro.cloudflare.wrangler.triggers ??= {}
    nitro.cloudflare.wrangler.triggers.crons = buildCronUnion(tasks, nitro.cloudflare.wrangler.triggers.crons ?? [])
  }

  // 4. Validate-and-suggest against an external wrangler file that manages crons
  //    directly (mirrors the queue cross-check). Files with no `[triggers]`
  //    block are left alone — nitro generates that section from the config above.
  if (options.validateWrangler !== false && cronUnion.length > 0) {
    addTemplate({
      filename: 'cf-jobs/crons.suggested.toml',
      write: true,
      getContents: () => renderSuggestedCronsToml(cronUnion),
    })
    const wranglerPath = options.wranglerPath ? resolve(rootDir, options.wranglerPath) : findWranglerConfig(rootDir)
    if (wranglerPath) {
      const { crons } = parseWranglerConfig(wranglerPath)
      if (crons !== undefined) {
        const { missing, extra } = crossCheckCrons(crons, cronUnion)
        if (missing.length > 0)
          logger.warn(`nuxt-cf-jobs / cron drift in ${wranglerPath}: missing trigger(s) ${missing.join(', ')} — those scheduled tasks won't fire on deploy. See ${resolve(templateDir, 'crons.suggested.toml')}.`)
        if (extra.length > 0)
          logger.info(`nuxt-cf-jobs: ${wranglerPath} declares cron trigger(s) no task uses: ${extra.join(', ')}.`)
      }
    }
  }

  logger.info(`nuxt-cf-jobs: registered ${tasks.length} task(s); ${scheduled.length} scheduled across ${cronUnion.length} cron(s)${enableSchedule ? '' : ' (schedule disabled in dev)'}.`)
}

/**
 * Resolve `cfJobs.tasksDir` into a concrete dir list. `true` auto-discovers
 * `server/tasks` across the app + every extended layer (`nuxt.options._layers`);
 * a string/array is passed through (collectTasks resolves them from rootDir).
 */
function resolveTaskDirs(tasksDir: NonNullable<ModuleOptions['tasksDir']>, nuxt: Nuxt): string[] {
  if (tasksDir !== true)
    return Array.isArray(tasksDir) ? tasksDir : [tasksDir]

  const layers = (nuxt.options as { _layers?: Array<{ cwd?: string, config?: { rootDir?: string } }> })._layers ?? []
  const dirs = [
    resolve(nuxt.options.rootDir, 'server/tasks'),
    ...layers
      .map(layer => layer.cwd ?? layer.config?.rootDir)
      .filter((cwd): cwd is string => !!cwd)
      .map(cwd => resolve(cwd, 'server/tasks')),
  ]
  return [...new Set(dirs)]
}

function runWranglerCrossCheck(options: ModuleOptions, rootDir: string, templateDir: string, nitroOptions: unknown): void {
  const logger = useLogger('nuxt-cf-jobs')
  const wranglerPath = options.wranglerPath
    ? resolve(rootDir, options.wranglerPath)
    : findWranglerConfig(rootDir)

  const { expectations, suggestedToml, merged, issues } = reconcileQueues({
    queues: options.queues,
    fileWrangler: wranglerPath ? parseWranglerConfig(wranglerPath) : undefined,
    nitroOptions,
    fallbackPath: wranglerPath ?? rootDir,
  })

  if (expectations.length === 0)
    return

  // Always emit the suggested wrangler snippet so users can diff it.
  addTemplate({
    filename: 'cf-jobs/wrangler.suggested.toml',
    write: true,
    getContents: () => suggestedToml,
  })

  if (!merged) {
    logger.warn(`No wrangler.{toml,jsonc,json} found in ${rootDir} and no queues declared via nitro.cloudflare.wrangler. See ${resolve(templateDir, 'wrangler.suggested.toml')} for the expected [[queues.producers]] / [[queues.consumers]] blocks.`)
    return
  }

  if (issues.length === 0)
    return

  const lines = issues.map(i => `  - [${i.logical}] ${i.reason}: ${i.detail}`)
  logger.warn(`nuxt-cf-jobs / wrangler config drift in ${merged.path}:\n${lines.join('\n')}\nSee ${resolve(templateDir, 'wrangler.suggested.toml')} for the expected blocks.`)
}

export async function generateRegistryTemplate(options: ModuleOptions, rootDir: string, templateDir: string): Promise<string> {
  const files = await resolveJobFiles(options, rootDir)
  await assertUniqueGeneratedJobNames(files, options, rootDir)

  // Build a data-only entry per job: static routing metadata read from the
  // source's `defineJob({...})` call (no module evaluation) plus a lazy
  // `load()` dynamic import. Rollup code-splits each `import()`, so a worker
  // only evaluates the one job it dispatches — not the whole batch.
  const entryLines = await Promise.all(files.map(async (file) => {
    const meta = extractJobMeta(await readFile(file, 'utf8').catch(() => ''))
    // The registry key is the declared `defineJob({ name })` when present, else
    // the file path. The `#cf-jobs/app` type augmentation keys off `Job['name']`
    // (the declared literal), so honouring it here keeps runtime + types aligned.
    const name = meta.name ?? toJobName(file, options, rootDir)
    const importPath = toImportPath(templateDir, file).replace(TS_EXTENSION_RE, '')
    const fields = [`name: ${JSON.stringify(name)}`]
    if (meta.queue !== undefined)
      fields.push(`queue: ${JSON.stringify(meta.queue)}`)
    if (meta.jobType !== undefined)
      fields.push(`jobType: ${JSON.stringify(meta.jobType)}`)
    if (meta.maxAttempts !== undefined)
      fields.push(`maxAttempts: ${meta.maxAttempts}`)
    if (meta.tries !== undefined)
      fields.push(`tries: ${meta.tries}`)
    if (meta.unique !== undefined)
      fields.push(`unique: ${meta.unique}`)
    if (meta.hasInput)
      fields.push(`hasInput: true`)
    if (meta.hasUniqueId)
      fields.push(`hasUniqueId: true`)
    fields.push(`load: () => import(${JSON.stringify(importPath)}).then(m => m.default)`)
    return `  { ${fields.join(', ')} },`
  }))

  // Emitted as plain JS (no `as const` / type syntax): the nitro server rollup
  // parses this file as JavaScript and rejects TS-only syntax. Types come from
  // the separate `declare module` augmentation, not this value module.
  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    `import { useRuntimeConfig } from 'nitropack/runtime'`,
    `import { createGeneratedCfJobsApp } from 'nuxt-cf-jobs/server'`,
    '',
    'export const jobs = [',
    ...entryLines,
    ']',
    `export const app = createGeneratedCfJobsApp(jobs, useRuntimeConfig, ${options.defaultQueue ? JSON.stringify(options.defaultQueue) : 'undefined'})`,
    '',
    'export const {',
    ...cfJobsAppExportNames.map(name => `  ${name},`),
    '} = app',
    '',
  ].join('\n')
}

/**
 * Emits a `declare module '#cf-jobs/app'` augmentation. The data-only runtime
 * `registry.ts` carries no hand-written types; this augmentation MERGES the
 * type-only aliases into that module so consumers can `import type { JobName,
 * JobPayload } from '#cf-jobs/app'`. Types are derived from each job's *full*
 * default-export type via `typeof import(...)` — purely type-level, so no
 * handler module is loaded to compute them.
 */
export async function generateRegistryTypesTemplate(options: ModuleOptions, rootDir: string, templateDir: string): Promise<string> {
  const files = await resolveJobFiles(options, rootDir)
  assertUniqueGeneratedJobNames(files, options, rootDir)
  const jobTypeLines = files.map((file) => {
    return `    typeof import(${JSON.stringify(toImportPath(templateDir, file).replace(TS_EXTENSION_RE, ''))})['default'],`
  })
  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    `import type { JobMessageByName, JobMessageByQueue, JobNameOf, JobPayloadOf, JobQueueByName, QueueNameOf } from 'nuxt-cf-jobs/server'`,
    '',
    `declare module '#cf-jobs/app' {`,
    `  export type { QueueConsumerOptions } from 'nuxt-cf-jobs/server'`,
    '  type Jobs = readonly [',
    ...jobTypeLines,
    '  ]',
    '  type JobsByName = { readonly [Job in Jobs[number] as Job[\'name\']]: Job }',
    '  export type JobName = keyof JobsByName & JobNameOf<Jobs>',
    '  export type JobDefinitionOf<Name extends JobName> = JobsByName[Name]',
    '  export type QueueName = QueueNameOf<Jobs>',
    '  export type JobPayload<Name extends JobName> = JobPayloadOf<JobDefinitionOf<Name>>',
    '  export type JobQueue<Name extends JobName> = JobQueueByName<Jobs, Name>',
    '  export type JobMessage<Name extends JobName> = JobMessageByName<Jobs, Name>',
    '  export type QueueMessage<Queue extends QueueName> = JobMessageByQueue<Jobs, Queue>',
    '}',
    '',
  ].join('\n')
}

async function resolveJobFiles(options: ModuleOptions, rootDir: string): Promise<string[]> {
  const dirs = toArray(options.jobsDir ?? 'server/jobs')
  const pattern = options.jobsPattern ?? '**/*.ts'
  const ignore = options.jobsIgnore ?? []
  const files = await Promise.all(dirs.map((dir) => {
    const resolvedDir = resolve(rootDir, dir)
    if (!existsSync(resolvedDir))
      return []
    return resolveFiles(resolvedDir, pattern, { ignore })
  }))
  return files.flat()
}

async function assertUniqueGeneratedJobNames(files: string[], options: ModuleOptions, rootDir: string): Promise<void> {
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  for (const file of files) {
    // Resolve the same way as the registry entry: declared `name` wins, file path
    // is the fallback. Collisions are checked on the actual runtime key.
    const meta = extractJobMeta(await readFile(file, 'utf8').catch(() => ''))
    const name = meta.name ?? toJobName(file, options, rootDir)
    const previous = seen.get(name)
    if (previous)
      duplicates.push(`${name} (${previous}, ${file})`)
    else
      seen.set(name, file)
  }

  if (duplicates.length > 0)
    throw new Error(`Duplicate nuxt-cf-jobs generated job names: ${duplicates.join(', ')}`)
}

function isWatchedJobPath(path: string, options: ModuleOptions, rootDir: string): boolean {
  const dirs = toArray(options.jobsDir ?? 'server/jobs').map(dir => resolve(rootDir, dir))
  const absolutePath = resolve(rootDir, path)
  return dirs.some(dir => absolutePath === dir || absolutePath.startsWith(dir + sep))
}

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

function toImportPath(fromDir: string, file: string): string {
  // Keep the source extension so Node ESM can resolve the path verbatim (Vite
  // / Nitro handle the `.ts` → bundled mapping at build time). Stripping the
  // extension forces extension-less resolution which Node refuses outside the
  // bundler.
  const path = relative(fromDir, file).replace(/\\/g, '/')
  return path.startsWith('.') ? path : `./${path}`
}

function toJobName(file: string, options: ModuleOptions, rootDir: string): string {
  const jobDirs = toArray(options.jobsDir ?? 'server/jobs')
  const dirs = jobDirs
    .map(dir => resolve(rootDir, dir))
    .sort((a, b) => b.length - a.length)
  const dir = dirs.find(dir => file.startsWith(`${dir}/`) || file === dir)
  const fallbackDir = jobDirs[0] ?? 'server/jobs'
  const path = relative(dir ?? resolve(rootDir, fallbackDir), file)
    .replace(WINDOWS_SLASH_RE, '/')
    .replace(JOB_FILE_EXTENSION_RE, '')
  return path.replace(INDEX_ROUTE_RE, '')
}
