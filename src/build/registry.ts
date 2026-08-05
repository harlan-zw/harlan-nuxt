import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions } from '../types'
import { existsSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addTemplate, addTypeTemplate, resolveFiles } from '@nuxt/kit'
import { cfJobsAppExportNames } from '../runtime/server/app'
import { extractJobMeta } from './extract-job-meta'

const WINDOWS_SLASH_RE = /\\/g
const FILE_URL_PREFIX_RE = /^file:\/*/
const JOB_FILE_EXTENSION_RE = /\.[cm]?tsx?$/
const INDEX_ROUTE_RE = /\/index$/

type NitroExternalInlineEntry = string | RegExp | ((id: string, importer?: string) => boolean | Promise<boolean>)

export interface RegistryBuildPlanEntry {
  file: string
  name: string
  importPath: string
  meta: ReturnType<typeof extractJobMeta>
}

export interface RegistryBuildPlan {
  entries: RegistryBuildPlanEntry[]
  defaultQueue?: string
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
  const sourceTracker = createRegistrySourceTracker(nuxt)
  const legacyRegistryTemplate = resolve(nuxt.options.buildDir, 'cf-jobs/registry.ts')
  if (existsSync(legacyRegistryTemplate))
    unlinkSync(legacyRegistryTemplate)

  const registryTemplate = addTemplate({
    filename: 'cf-jobs/registry.js',
    write: true,
    getContents: async () => generateRegistryTemplate(options, nuxt.options.rootDir, templateDir, await sourceTracker.collect()),
  })
  nuxt.options.alias['#cf-jobs/app'] = registryTemplate.dst
  if (options.registryAlias && options.registryAlias !== '#cf-jobs/app')
    nuxt.options.alias[options.registryAlias] = registryTemplate.dst
  inlineRegistryTemplateInNitroDev(nuxt, registryTemplate.dst)

  const typesTemplate = addTypeTemplate({
    filename: 'cf-jobs/registry-augmentation.d.ts',
    getContents: async () => generateRegistryTypesTemplate(options, nuxt.options.rootDir, templateDir, await sourceTracker.collect()),
  }, { nuxt: true, nitro: true })

  nuxt.hooks.hook('builder:watch' as never, (async (_event: string, path: string) => {
    if (!isWatchedJobPath(path, options, nuxt.options.rootDir) && !(await sourceTracker.isWatched(path, nuxt.options.rootDir)))
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

export function inlineRegistryTemplateInNitroDev(nuxt: Nuxt, registryTemplatePath: string): void {
  if (!nuxt.options.dev)
    return

  const nitro = ((nuxt.options as { nitro?: { externals?: { inline?: NitroExternalInlineEntry | NitroExternalInlineEntry[] } } }).nitro ??= {})
  nitro.externals ??= {}

  const inline = nitro.externals.inline
  const registryPath = normalizeImportId(registryTemplatePath)
  const matchRegistryTemplate = (id: string) => normalizeImportId(id) === registryPath

  nitro.externals.inline = [
    ...(Array.isArray(inline) ? inline : inline ? [inline] : []),
    matchRegistryTemplate,
  ]
}

export async function buildRegistryPlan(options: ModuleOptions, rootDir: string, templateDir: string, sources: readonly RegistrySource[] = []): Promise<RegistryBuildPlan> {
  const files = await resolveJobFiles(options, rootDir)
  const discovered = files.map(file => ({ file }))
  const uniqueSources = dedupeRegistrySources([...discovered, ...sources])
  const entries = await Promise.all(uniqueSources.map(async (source): Promise<RegistryBuildPlanEntry> => {
    const file = resolve(source.file)
    const meta = extractJobMeta(await readFile(file, 'utf8'))
    return {
      file,
      meta,
      name: source.name ?? meta.name ?? toJobName(file, options, rootDir),
      importPath: toImportPath(templateDir, file).replace(JOB_FILE_EXTENSION_RE, ''),
    }
  }))
  assertUniqueGeneratedJobNames(entries)

  return { entries, defaultQueue: options.defaultQueue }
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
    if (entry.meta.maxAttempts !== undefined)
      fields.push(`maxAttempts: ${entry.meta.maxAttempts}`)
    if (entry.meta.tries !== undefined)
      fields.push(`tries: ${entry.meta.tries}`)
    if (entry.meta.unique !== undefined)
      fields.push(`unique: ${entry.meta.unique}`)
    if (entry.meta.hasInput)
      fields.push(`hasInput: true`)
    if (entry.meta.hasUniqueId)
      fields.push(`hasUniqueId: true`)
    fields.push(`load: () => import(${JSON.stringify(entry.importPath)}).then(m => m.default)`)
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
    // only provided inside the nitro rollup build (dies everywhere else). nitro's
    // `useRuntimeConfig` is instead injected at startup by the always-registered
    // `provide-runtime-config` server plugin, which IS bundled by nitro and can
    // safely reach the runtime.
    `import { createGeneratedCfJobsApp } from 'nuxt-cf-jobs/server'`,
    '',
    'export const jobs = [',
    ...entryLines,
    ']',
    `/** @type {import('nuxt-cf-jobs/server').CfJobsApp<${jobsType}>} */`,
    `export const app = createGeneratedCfJobsApp(jobs, ${plan.defaultQueue ? JSON.stringify(plan.defaultQueue) : 'undefined'})`,
    '',
    'export const {',
    ...cfJobsAppExportNames.map(name => `  ${name},`),
    '} = app',
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
    `  export type { CfJobsDurableRuntimeOptions, QueueConsumerOptions } from 'nuxt-cf-jobs/server'`,
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
    '  export type JobBroadcastMessage<Name extends JobName> = JobBroadcastMessageByName<Jobs, Name>',
    '  export type JobBroadcastEnvelope<Name extends JobName> = JobBroadcastEnvelopeByName<Jobs, Name>',
    '  export type BroadcastMessage = BroadcastMessageOf<Jobs>',
    '  export type BroadcastEnvelope = BroadcastEnvelopeOf<Jobs>',
    '}',
    '',
  ])

  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    `import type { BroadcastEnvelopeOf, BroadcastMessageOf, JobBroadcastEnvelopeByName, JobBroadcastMessageByName, JobMessageByName, JobMessageByQueue, JobNameOf, JobPayloadOf, JobQueueByName, QueueNameOf } from 'nuxt-cf-jobs/server'`,
    '',
    ...moduleBlocks,
  ].join('\n')
}

function quoteModuleSpecifier(value: string): string {
  const escapedQuote = '\\\''
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, escapedQuote)}'`
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

function isWatchedJobPath(path: string, options: ModuleOptions, rootDir: string): boolean {
  const dirs = toArray(options.jobsDir ?? 'server/jobs').map(dir => resolve(rootDir, dir))
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

function normalizeImportId(id: string): string {
  if (id.startsWith('file://')) {
    try {
      return fileURLToPath(id).replace(WINDOWS_SLASH_RE, '/')
    }
    catch {
      return id.replace(FILE_URL_PREFIX_RE, '/').replace(WINDOWS_SLASH_RE, '/')
    }
  }

  return id.replace(WINDOWS_SLASH_RE, '/')
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
