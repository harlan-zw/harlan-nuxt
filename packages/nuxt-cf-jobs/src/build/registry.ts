import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions } from '../types'
import { existsSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { addTemplate, addTypeTemplate, resolveFiles, useLogger } from '@nuxt/kit'
import { cfJobsAppExportNames } from '../runtime/shared/app-exports'
import { extractJobMeta } from './extract-job-meta'
import { resolveLayeredDirs } from './layers'
import { inlineTemplateInNitroDev } from './nitro-dev'

const WINDOWS_SLASH_RE = /\\/g
const JOB_FILE_EXTENSION_RE = /\.[cm]?tsx?$/
const INDEX_ROUTE_RE = /\/index$/

export const DEFAULT_JOBS_DIR = 'server/jobs'

export interface RegistryBuildPlanEntry {
  file: string
  name: string
  /** Extensionless specifier. Type positions only: `import("x.ts")` is not a valid type. */
  importPath: string
  /**
   * Specifier for the runtime `import()`, extension included.
   *
   * Node's ESM loader reads this module directly whenever Nitro leaves the
   * generated registry outside its bundle (dev tasks). Node requires the
   * extension, so an extensionless specifier throws `Cannot find module` and no
   * durable job ever runs. Bundlers resolve both forms to the same file.
   */
  loadPath: string
  meta: ReturnType<typeof extractJobMeta>
}

export interface RegistryBuildPlan {
  entries: RegistryBuildPlanEntry[]
  defaultQueue?: string
  /** Build-time defects that make a job silently unroutable at runtime. */
  warnings: string[]
}

/** A job module contributed by another Nuxt module. The file stays lazy. */
export interface RegistrySource {
  file: string
  /** Overrides a missing or statically unreadable definition name. */
  name?: string
}

export interface RegistrySourcesContext {
  sources: RegistrySource[]
}

export interface RegistrySourceTracker {
  collect: () => Promise<RegistrySource[]>
  isWatched: (path: string, rootDir: string) => Promise<boolean>
}

/**
 * Owns the generated `#cf-jobs/app` value module + type augmentation as one
 * build-time seam. `module.ts` remains the Nuxt adapter; discovery, rendering,
 * alias registration, and watch invalidation stay local here.
 */
export function installRegistryTemplates(options: ModuleOptions, nuxt: Nuxt, templateDir: string): void {
  const logger = useLogger('nuxt-cf-jobs')
  const sourceTracker = createRegistrySourceTracker(nuxt)
  // `jobsDir: true` auto-discovers `server/jobs` across the app + every extended
  // layer. Resolve it once, here, so discovery, name derivation and watch
  // invalidation all read the same concrete dir list.
  const resolved: ModuleOptions = { ...options, jobsDir: resolveJobDirs(options.jobsDir, nuxt) }
  const legacyRegistryTemplate = resolve(nuxt.options.buildDir, 'cf-jobs/registry.ts')
  if (existsSync(legacyRegistryTemplate))
    unlinkSync(legacyRegistryTemplate)

  const registryTemplate = addTemplate({
    filename: 'cf-jobs/registry.js',
    write: true,
    getContents: async () => {
      const plan = await buildRegistryPlan(resolved, nuxt.options.rootDir, templateDir, await sourceTracker.collect())
      for (const warning of plan.warnings)
        logger.warn(warning)
      return renderRegistryTemplate(plan)
    },
  })
  nuxt.options.alias['#cf-jobs/app'] = registryTemplate.dst
  if (options.registryAlias && options.registryAlias !== '#cf-jobs/app')
    nuxt.options.alias[options.registryAlias] = registryTemplate.dst
  inlineTemplateInNitroDev(nuxt, registryTemplate.dst)

  const typesTemplate = addTypeTemplate({
    filename: 'cf-jobs/registry-augmentation.d.ts',
    getContents: async () => generateRegistryTypesTemplate(resolved, nuxt.options.rootDir, templateDir, await sourceTracker.collect()),
  }, { nuxt: true, nitro: true })

  nuxt.hooks.hook('builder:watch' as never, (async (_event: string, path: string) => {
    if (!isWatchedJobPath(path, resolved, nuxt.options.rootDir) && !(await sourceTracker.isWatched(path, nuxt.options.rootDir)))
      return
    await nuxt.callHook('builder:generateApp', {
      filter: template => template.dst === registryTemplate.dst || template.dst === typesTemplate.dst,
    })
  }) as never)
}

/** Collect registry contributions at render time to avoid Nuxt module order coupling. */
export async function collectRegistrySources(nuxt: Pick<Nuxt, 'callHook'>): Promise<RegistrySource[]> {
  const context: RegistrySourcesContext = { sources: [] }
  const callHook = nuxt.callHook as unknown as (name: 'cf-jobs:registry:sources', context: RegistrySourcesContext) => Promise<void>
  await callHook.call(nuxt, 'cf-jobs:registry:sources', context)
  return context.sources
}

export function createRegistrySourceTracker(nuxt: Pick<Nuxt, 'callHook'>): RegistrySourceTracker {
  let previous: RegistrySource[] = []
  const collect = async (): Promise<RegistrySource[]> => {
    previous = await collectRegistrySources(nuxt)
    return previous
  }
  return {
    collect,
    async isWatched(path, rootDir) {
      const prior = previous
      const current = await collect()
      return isWatchedRegistrySource(path, current, rootDir)
        || isWatchedRegistrySource(path, prior, rootDir)
    },
  }
}

export async function buildRegistryPlan(options: ModuleOptions, rootDir: string, templateDir: string, sources: readonly RegistrySource[] = []): Promise<RegistryBuildPlan> {
  const files = await resolveJobFiles(options, rootDir)
  const discovered = files.map(file => ({ file }))
  const uniqueSources = dedupeRegistrySources([...discovered, ...sources])
  const entries = await Promise.all(uniqueSources.map(async (source): Promise<RegistryBuildPlanEntry> => {
    const file = resolve(source.file)
    const meta = extractJobMeta(await readFile(file, 'utf8'), file)
    const loadPath = toImportPath(templateDir, file)
    return {
      file,
      meta,
      name: source.name ?? meta.name ?? toJobName(file, options, rootDir),
      importPath: loadPath.replace(JOB_FILE_EXTENSION_RE, ''),
      loadPath,
    }
  }))
  assertUniqueGeneratedJobNames(entries)

  return { entries, defaultQueue: options.defaultQueue, warnings: collectRegistryWarnings(entries, options, rootDir) }
}

/**
 * Report every job whose queue cannot be verified at build time.
 *
 * A wrong queue is otherwise silent end to end: `extractJobMeta` drops a
 * non-literal `queue`, and `send()` later returns `false` behind one
 * `console.warn` in a Worker log nobody reads.
 */
function collectRegistryWarnings(entries: readonly RegistryBuildPlanEntry[], options: ModuleOptions, rootDir: string): string[] {
  const declared = new Set(Object.keys(options.queues ?? {}))
  const warnings: string[] = []
  for (const entry of entries) {
    const where = relative(rootDir, entry.file)
    if (entry.meta.unreadable?.includes('queue')) {
      warnings.push(`job "${entry.name}" (${where}) sets \`queue\` to a value this build cannot read. Use a string literal, or the job never routes.`)
      continue
    }
    if (entry.meta.queue === undefined) {
      if (!options.defaultQueue)
        warnings.push(`job "${entry.name}" (${where}) declares no \`queue\` and \`cfJobs.defaultQueue\` is unset. The job never routes.`)
      continue
    }
    if (declared.size > 0 && !declared.has(entry.meta.queue))
      warnings.push(`job "${entry.name}" (${where}) targets queue "${entry.meta.queue}", which is not a key of \`cfJobs.queues\`. Check the spelling, or the job never routes.`)
  }
  if (entries.some(entry => entry.meta.unreadable?.includes('maxAttempts'))) {
    const files = entries.filter(entry => entry.meta.unreadable?.includes('maxAttempts')).map(entry => relative(rootDir, entry.file))
    warnings.push(`\`maxAttempts\` was removed from \`defineJob\`. Rename it to \`tries\` in: ${files.join(', ')}.`)
  }
  return warnings
}

export async function generateRegistryTemplate(options: ModuleOptions, rootDir: string, templateDir: string, sources: readonly RegistrySource[] = []): Promise<string> {
  return renderRegistryTemplate(await buildRegistryPlan(options, rootDir, templateDir, sources))
}

export async function generateRegistryTypesTemplate(options: ModuleOptions, rootDir: string, templateDir: string, sources: readonly RegistrySource[] = []): Promise<string> {
  return renderRegistryTypesTemplate(
    await buildRegistryPlan(options, rootDir, templateDir, sources),
    options.registryAlias ?? '#cf-jobs/app',
  )
}

function dedupeRegistrySources(sources: RegistrySource[]): RegistrySource[] {
  const byFile = new Map<string, RegistrySource>()
  for (const source of sources) {
    const file = resolve(source.file)
    const previous = byFile.get(file)
    byFile.set(file, {
      ...previous,
      ...source,
      file,
      ...(source.name === undefined && previous?.name !== undefined ? { name: previous.name } : {}),
    })
  }
  return [...byFile.values()]
}

function renderRegistryTemplate(plan: RegistryBuildPlan): string {
  const entryLines = plan.entries.map((entry) => {
    const fields = [`name: ${JSON.stringify(entry.name)}`]
    if (entry.meta.queue !== undefined)
      fields.push(`queue: ${JSON.stringify(entry.meta.queue)}`)
    if (entry.meta.jobType !== undefined)
      fields.push(`jobType: ${JSON.stringify(entry.meta.jobType)}`)
    if (entry.meta.tries !== undefined)
      fields.push(`tries: ${entry.meta.tries}`)
    if (entry.meta.unique !== undefined)
      fields.push(`unique: ${entry.meta.unique}`)
    if (entry.meta.hasInput)
      fields.push(`hasInput: true`)
    if (entry.meta.hasUniqueId)
      fields.push(`hasUniqueId: true`)
    fields.push(`load: () => import(${JSON.stringify(entry.loadPath)}).then(m => m.default)`)
    return `  { ${fields.join(', ')} },`
  })
  const jobsType = `readonly [${plan.entries.map(entry => `typeof import(${JSON.stringify(entry.importPath)})['default']`).join(', ')}]`
  // The registry is a generated *runtime* module: keep it plain JavaScript so it
  // never needs transpiling on its way into the bundle. Emitting TypeScript here
  // (e.g. `import type`, type aliases, generics) breaks builds where the Nuxt
  // buildDir lives under `node_modules` (e.g. `node_modules/.cache/nuxt/.nuxt`),
  // because nitro/rollup's esbuild transform skips `node_modules` and rollup then
  // parses the raw `.ts` as JS and fails ("Expected ',', got '{'" on `import type`).
  // Per-job value precision is carried by a JSDoc `@type` on `app`; type aliases
  // (JobName, JobPayload, JobMessage, …) live in `registry-augmentation.d.ts`.
  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    // This module is imported in every context — bundled nitro, the Vite app
    // build, AND raw Node (it's emitted into the consumer's buildDir). Nitro dev
    // explicitly inlines it so relative job imports resolve through rollup
    // instead of native Node ESM, but the registry still must import NOTHING that
    // only resolves in one context: `#imports` is a build-only Nuxt virtual (dies
    // in raw Node), and `nitropack/runtime` eagerly pulls nitro's
    // `internal/storage.mjs` whose `#nitro-internal-virtual/storage` import is
    // only provided inside the nitro rollup build (dies everywhere else).
    // Nitro aliases this adapter to its runtime implementation. Other contexts
    // resolve the safe package provider without pulling Nitro into their graph.
    `import { useJobRuntimeConfig } from '@harlan-zw/nuxt-cf-jobs/runtime-config'`,
    `import { createGeneratedCfJobsApp } from '@harlan-zw/nuxt-cf-jobs/app'`,
    '',
    'export const jobs = [',
    ...entryLines,
    ']',
    `/** @type {import('@harlan-zw/nuxt-cf-jobs/server').CfJobsApp<${jobsType}>} */`,
    'export const app = createGeneratedCfJobsApp(jobs, {',
    `  defaultQueue: ${plan.defaultQueue ? JSON.stringify(plan.defaultQueue) : 'undefined'},`,
    '  useRuntimeConfig: event => useJobRuntimeConfig(event),',
    '})',
    '',
    'export const {',
    ...cfJobsAppExportNames.filter(name => name !== 'getQueue').map(name => `  ${name},`),
    '} = app',
    `/** @type {ReturnType<typeof createGeneratedCfJobsApp>['getQueue']} */`,
    'export const getQueue = app.getQueue',
    '',
  ].join('\n')
}

function renderRegistryTypesTemplate(plan: RegistryBuildPlan, registryAlias: string): string {
  const jobTypeLines = plan.entries.map((entry) => {
    return `    typeof import(${JSON.stringify(entry.importPath)})['default'],`
  })
  const aliases = [...new Set(['#cf-jobs/app', registryAlias])]
  const moduleBlocks = aliases.flatMap((alias, index) => [
    `declare module ${index === 0 ? quoteModuleSpecifier(alias) : JSON.stringify(alias)} {`,
    `  export type { CfJobsDurableRuntimeOptions, QueueConsumerOptions } from '@harlan-zw/nuxt-cf-jobs/server'`,
    '  type Jobs = readonly [',
    ...jobTypeLines,
    '  ]',
    `  type App = import('@harlan-zw/nuxt-cf-jobs/server').CfJobsApp<Jobs>`,
    `  type GeneratedApp = ReturnType<(typeof import('@harlan-zw/nuxt-cf-jobs/server'))['createGeneratedCfJobsApp']>`,
    '  type JobsByName = { readonly [Job in Jobs[number] as Job[\'name\']]: Job }',
    '  export const jobs: Jobs',
    '  export const app: App',
    ...cfJobsAppExportNames.map(name => `  export const ${name}: ${name === 'getQueue' ? 'GeneratedApp' : 'App'}[${JSON.stringify(name)}]`),
    '  export type JobName = keyof JobsByName & JobNameOf<Jobs>',
    '  export type JobDefinitionOf<Name extends JobName> = JobsByName[Name]',
    '  export type QueueName = QueueNameOf<Jobs>',
    '  export type JobPayload<Name extends JobName> = JobPayloadOf<JobDefinitionOf<Name>>',
    '  export type JobQueue<Name extends JobName> = JobQueueByName<Jobs, Name>',
    '  export type JobMessage<Name extends JobName> = JobMessageByName<Jobs, Name>',
    '  export type QueueMessage<Queue extends QueueName> = JobMessageByQueue<Jobs, Queue>',
    '  export type JobBroadcastMessage<Name extends JobName> = JobBroadcastMessageByName<Jobs, Name>',
    '  export type JobBroadcastEnvelope<Name extends JobName> = JobBroadcastEnvelopeByName<Jobs, Name>',
    '  export type BroadcastMessage = BroadcastMessageOf<Jobs>',
    '  export type BroadcastEnvelope = BroadcastEnvelopeOf<Jobs>',
    '}',
    '',
  ])

  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    `import type { BroadcastEnvelopeOf, BroadcastMessageOf, JobBroadcastEnvelopeByName, JobBroadcastMessageByName, JobMessageByName, JobMessageByQueue, JobNameOf, JobPayloadOf, JobQueueByName, QueueNameOf } from '@harlan-zw/nuxt-cf-jobs/server'`,
    '',
    ...moduleBlocks,
  ].join('\n')
}

function quoteModuleSpecifier(value: string): string {
  const escapedQuote = '\\\''
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, escapedQuote)}'`
}

/**
 * Resolve `cfJobs.jobsDir` into a concrete dir list. `true` auto-discovers
 * `server/jobs` across the app + every extended layer, mirroring `tasksDir`.
 */
export function resolveJobDirs(jobsDir: ModuleOptions['jobsDir'], nuxt: Nuxt): string[] {
  return resolveLayeredDirs(jobsDir, nuxt, DEFAULT_JOBS_DIR, DEFAULT_JOBS_DIR)
}

async function resolveJobFiles(options: ModuleOptions, rootDir: string): Promise<string[]> {
  const dirs = toJobDirs(options.jobsDir)
  const pattern = options.jobsPattern ?? '**/*.ts'
  const ignore = options.jobsIgnore ?? []
  const files = await Promise.all(dirs.map((dir) => {
    const resolvedDir = resolve(rootDir, dir)
    if (!existsSync(resolvedDir))
      return []
    return resolveFiles(resolvedDir, pattern, { ignore })
  }))
  return [...new Set(files.flat())]
}

function assertUniqueGeneratedJobNames(entries: RegistryBuildPlanEntry[]): void {
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  for (const entry of entries) {
    const previous = seen.get(entry.name)
    if (previous)
      duplicates.push(`${entry.name} (${previous}, ${entry.file})`)
    else
      seen.set(entry.name, entry.file)
  }

  if (duplicates.length > 0)
    throw new Error(`Duplicate nuxt-cf-jobs generated job names: ${duplicates.join(', ')}`)
}

function toJobDirs(jobsDir: ModuleOptions['jobsDir']): string[] {
  if (jobsDir === undefined)
    return [DEFAULT_JOBS_DIR]
  if (typeof jobsDir === 'boolean')
    return jobsDir ? [DEFAULT_JOBS_DIR] : []
  return toArray(jobsDir)
}

function isWatchedJobPath(path: string, options: ModuleOptions, rootDir: string): boolean {
  const dirs = toJobDirs(options.jobsDir).map(dir => resolve(rootDir, dir))
  const absolutePath = resolve(rootDir, path)
  return dirs.some(dir => absolutePath === dir || absolutePath.startsWith(dir + sep))
}

function isWatchedRegistrySource(path: string, sources: readonly RegistrySource[], rootDir: string): boolean {
  const absolutePath = resolve(rootDir, path)
  return sources.some(source => resolve(source.file) === absolutePath)
}

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

function toImportPath(fromDir: string, file: string): string {
  const path = relative(fromDir, file).replace(/\\/g, '/')
  return path.startsWith('.') ? path : `./${path}`
}

function toJobName(file: string, options: ModuleOptions, rootDir: string): string {
  const jobDirs = toJobDirs(options.jobsDir)
  const dirs = jobDirs
    .map(dir => resolve(rootDir, dir))
    .sort((a, b) => b.length - a.length)
  const dir = dirs.find(dir => file.startsWith(`${dir}/`) || file === dir)
  const fallbackDir = jobDirs[0] ?? DEFAULT_JOBS_DIR
  const path = relative(dir ?? resolve(rootDir, fallbackDir), file)
    .replace(WINDOWS_SLASH_RE, '/')
    .replace(JOB_FILE_EXTENSION_RE, '')
  return path.replace(INDEX_ROUTE_RE, '')
}
