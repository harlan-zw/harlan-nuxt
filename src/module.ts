import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions } from './types'
import type { ModuleQueueExpectation, WranglerConfig, WranglerQueueConsumer, WranglerQueueProducer } from './wrangler'
import { existsSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { addServerImports, addServerPlugin, addTemplate, createResolver, defineNuxtModule, resolveFiles, updateTemplates, useLogger } from '@nuxt/kit'
import { cfJobsAppExportNames } from './runtime/server/app'
import { buildCronUnion, buildScheduledTasks, collectTasks, findDuplicateTaskNames } from './tasks'
import {
  crossCheckCrons,
  crossCheckWrangler,
  findWranglerConfig,

  parseWranglerConfig,
  renderSuggestedCronsToml,
  renderSuggestedWranglerToml,

} from './wrangler'

export type { ModuleOptions } from './types'

declare module '@nuxt/schema' {
  interface RuntimeConfig {
    cfJobs: { queues: ModuleOptions['queues'], defaultQueue?: string }
  }
}

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
    addServerImports([
      { name: 'defineJob', from: resolver.resolve('./runtime/server/registry') },
      { name: 'defineScheduledTask', from: resolver.resolve('./runtime/server/scheduled') },
    ])
    const registryTemplate = addTemplate({
      filename: 'cf-jobs/registry.ts',
      write: true,
      getContents: async () => generateRegistryTemplate(options, nuxt.options.rootDir, resolve(nuxt.options.buildDir, 'cf-jobs')),
    })
    addTemplate({
      filename: 'cf-jobs/registry.d.ts',
      write: true,
      getContents: async () => generateRegistryTypesTemplate(options, nuxt.options.rootDir, resolve(nuxt.options.buildDir, 'cf-jobs')),
    })
    nuxt.options.alias[options.registryAlias ?? '#cf-jobs/app'] = registryTemplate.dst

    nuxt.hooks.hook('builder:watch' as never, (async (_event: string, path: string) => {
      if (!isWatchedJobPath(path, options, nuxt.options.rootDir))
        return
      await updateTemplates({ filter: template => template.dst === registryTemplate.dst })
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

  const expectations: ModuleQueueExpectation[] = []
  for (const [logical, config] of Object.entries(options.queues ?? {})) {
    const binding = typeof config === 'string' ? config : config?.binding
    if (!binding)
      continue
    const explicitQueueName = typeof config === 'object' && !!config?.queueName
    const cfQueueName = explicitQueueName ? (config as { queueName: string }).queueName : logical
    expectations.push({ logical, binding, cfQueueName, explicitQueueName })
  }

  if (expectations.length === 0)
    return

  // Always emit the suggested wrangler snippet so users can diff it.
  const suggested = renderSuggestedWranglerToml(expectations)
  addTemplate({
    filename: 'cf-jobs/wrangler.suggested.toml',
    write: true,
    getContents: () => suggested,
  })

  const nitroQueues = readNitroCloudflareQueues(nitroOptions)
  const fileWrangler = wranglerPath ? parseWranglerConfig(wranglerPath) : undefined
  const merged = mergeWranglerSources(fileWrangler, nitroQueues, wranglerPath ?? rootDir)

  if (!merged) {
    logger.warn(`No wrangler.{toml,jsonc,json} found in ${rootDir} and no queues declared via nitro.cloudflare.wrangler. See ${resolve(templateDir, 'wrangler.suggested.toml')} for the expected [[queues.producers]] / [[queues.consumers]] blocks.`)
    return
  }

  const issues = crossCheckWrangler(merged, expectations)
  if (issues.length === 0)
    return

  const lines = issues.map(i => `  - [${i.logical}] ${i.reason}: ${i.detail}`)
  logger.warn(`nuxt-cf-jobs / wrangler config drift in ${merged.path}:\n${lines.join('\n')}\nSee ${resolve(templateDir, 'wrangler.suggested.toml')} for the expected blocks.`)
}

function readNitroCloudflareQueues(nitroOptions: unknown): { producers: WranglerQueueProducer[], consumers: WranglerQueueConsumer[] } | undefined {
  const cf = (nitroOptions as { cloudflare?: { wrangler?: { queues?: { producers?: unknown[], consumers?: unknown[] } }, deploy?: { configuration?: { queues?: { producers?: unknown[], consumers?: unknown[] } } } } })?.cloudflare
  const queues = cf?.wrangler?.queues ?? cf?.deploy?.configuration?.queues
  if (!queues)
    return undefined
  const producers: WranglerQueueProducer[] = []
  const consumers: WranglerQueueConsumer[] = []
  for (const p of queues.producers ?? []) {
    if (!p || typeof p !== 'object')
      continue
    const obj = p as { binding?: unknown, queue?: unknown }
    if (typeof obj.binding === 'string' && typeof obj.queue === 'string')
      producers.push({ binding: obj.binding, queue: obj.queue })
  }
  for (const c of queues.consumers ?? []) {
    if (!c || typeof c !== 'object')
      continue
    const obj = c as Record<string, unknown>
    if (typeof obj.queue !== 'string')
      continue
    const consumer: WranglerQueueConsumer = { queue: obj.queue }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'queue') {
        continue
      }(consumer as unknown as Record<string, unknown>)[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v
    }
    consumers.push(consumer)
  }
  return { producers, consumers }
}

function mergeWranglerSources(
  fileWrangler: WranglerConfig | undefined,
  nitroQueues: { producers: WranglerQueueProducer[], consumers: WranglerQueueConsumer[] } | undefined,
  fallbackPath: string,
): WranglerConfig | undefined {
  if (!fileWrangler && !nitroQueues)
    return undefined
  const producerKey = (p: WranglerQueueProducer) => `${p.binding}::${p.queue}`
  const consumerKey = (c: WranglerQueueConsumer) => c.queue
  const producers = new Map<string, WranglerQueueProducer>()
  const consumers = new Map<string, WranglerQueueConsumer>()
  for (const p of fileWrangler?.producers ?? [])
    producers.set(producerKey(p), p)
  for (const c of fileWrangler?.consumers ?? [])
    consumers.set(consumerKey(c), c)
  for (const p of nitroQueues?.producers ?? [])
    producers.set(producerKey(p), p)
  for (const c of nitroQueues?.consumers ?? [])
    consumers.set(consumerKey(c), c)
  return {
    path: fileWrangler?.path ?? `${fallbackPath} (nitro.cloudflare.deploy.configuration)`,
    producers: [...producers.values()],
    consumers: [...consumers.values()],
  }
}

export async function generateRegistryTemplate(options: ModuleOptions, rootDir: string, templateDir: string): Promise<string> {
  const files = await resolveJobFiles(options, rootDir)
  assertUniqueGeneratedJobNames(files, options, rootDir)
  // Bundled `.ts`: rollup resolves nuxt `#aliases` and extensionless paths
  // inside each job source file, and `nitropack/runtime` is available because
  // the file is part of the nitro graph.
  const imports = files.map((file, index) => {
    return `import job${index} from ${JSON.stringify(toImportPath(templateDir, file).replace(/\.ts$/, ''))}`
  })
  const jobItems = files.map((_, index) => `job${index}`).join(', ')
  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    `import { useRuntimeConfig } from 'nitropack/runtime'`,
    `import { createGeneratedCfJobsApp } from 'nuxt-cf-jobs/server'`,
    ...imports,
    '',
    `export const jobs = [${jobItems}] as const`,
    `export const app = createGeneratedCfJobsApp(jobs, useRuntimeConfig, ${options.defaultQueue ? JSON.stringify(options.defaultQueue) : 'undefined'})`,
    '',
    'export const {',
    ...cfJobsAppExportNames.map(name => `  ${name},`),
    '} = app',
    '',
  ].join('\n')
}

export async function generateRegistryTypesTemplate(options: ModuleOptions, rootDir: string, templateDir: string): Promise<string> {
  const files = await resolveJobFiles(options, rootDir)
  assertUniqueGeneratedJobNames(files, options, rootDir)
  const jobTypeLines = files.map((file) => {
    return `  typeof import(${JSON.stringify(toImportPath(templateDir, file).replace(/\.ts$/, ''))})['default'],`
  })
  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    `import type { JobMessageByName, JobMessageByQueue, JobNameOf, JobPayloadByName, JobPayloadOf, JobQueueByName, QueueNameOf, QueueConsumerOptions } from 'nuxt-cf-jobs/server'`,
    `export type { QueueConsumerOptions }`,
    '',
    'export declare const jobs: readonly [',
    ...jobTypeLines,
    ']',
    'export declare const app: ReturnType<typeof import(\'nuxt-cf-jobs/server\').createCfJobsApp<typeof jobs>>',
    '',
    'export type Jobs = typeof jobs',
    'export type JobsByName = { readonly [Job in Jobs[number] as Job[\'name\']]: Job }',
    'export type JobName = keyof JobsByName & JobNameOf<Jobs>',
    'export type JobDefinitionOf<Name extends JobName> = JobsByName[Name]',
    'export type QueueName = QueueNameOf<Jobs>',
    'export type JobPayload<Name extends JobName> = JobPayloadOf<JobDefinitionOf<Name>>',
    'export type JobQueue<Name extends JobName> = JobQueueByName<Jobs, Name>',
    'export type JobMessage<Name extends JobName> = JobMessageByName<Jobs, Name>',
    'export type QueueMessage<Queue extends QueueName> = JobMessageByQueue<Jobs, Queue>',
    '',
    ...cfJobsAppExportNames.map(name => `export declare const ${name}: typeof app.${name}`),
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

function assertUniqueGeneratedJobNames(files: string[], options: ModuleOptions, rootDir: string): void {
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  for (const file of files) {
    const name = toJobName(file, options, rootDir)
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
    .replace(/\\/g, '/')
    .replace(/\.[cm]?tsx?$/, '')
  return path.replace(/\/index$/, '')
}
