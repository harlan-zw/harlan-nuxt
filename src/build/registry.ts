import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions } from '../types'
import { existsSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { addTemplate, addTypeTemplate, resolveFiles, updateTemplates } from '@nuxt/kit'
import { cfJobsAppExportNames } from '../runtime/server/app'
import { extractJobMeta } from './extract-job-meta'

const TS_EXTENSION_RE = /\.ts$/
const WINDOWS_SLASH_RE = /\\/g
const JOB_FILE_EXTENSION_RE = /\.[cm]?tsx?$/
const INDEX_ROUTE_RE = /\/index$/

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

/**
 * Owns the generated `#cf-jobs/app` value module + type augmentation as one
 * build-time seam. `module.ts` remains the Nuxt adapter; discovery, rendering,
 * alias registration, and watch invalidation stay local here.
 */
export function installRegistryTemplates(options: ModuleOptions, nuxt: Nuxt, templateDir: string): void {
  const legacyRegistryTemplate = resolve(nuxt.options.buildDir, 'cf-jobs/registry.ts')
  if (existsSync(legacyRegistryTemplate))
    unlinkSync(legacyRegistryTemplate)

  const registryTemplate = addTemplate({
    filename: 'cf-jobs/registry.js',
    write: true,
    getContents: async () => generateRegistryTemplate(options, nuxt.options.rootDir, templateDir),
  })
  nuxt.options.alias[options.registryAlias ?? '#cf-jobs/app'] = registryTemplate.dst

  const typesTemplate = addTypeTemplate({
    filename: 'cf-jobs/registry-augmentation.d.ts',
    getContents: async () => generateRegistryTypesTemplate(options, nuxt.options.rootDir, templateDir),
  }, { nuxt: true, nitro: true })

  nuxt.hooks.hook('builder:watch' as never, (async (_event: string, path: string) => {
    if (!isWatchedJobPath(path, options, nuxt.options.rootDir))
      return
    await updateTemplates({ filter: template => template.dst === registryTemplate.dst || template.dst === typesTemplate.dst })
  }) as never)
}

export async function buildRegistryPlan(options: ModuleOptions, rootDir: string, templateDir: string): Promise<RegistryBuildPlan> {
  const files = await resolveJobFiles(options, rootDir)
  await assertUniqueGeneratedJobNames(files, options, rootDir)

  const entries = await Promise.all(files.map(async (file): Promise<RegistryBuildPlanEntry> => {
    const meta = extractJobMeta(await readFile(file, 'utf8').catch(() => ''))
    return {
      file,
      meta,
      name: meta.name ?? toJobName(file, options, rootDir),
      importPath: toImportPath(templateDir, file).replace(TS_EXTENSION_RE, ''),
    }
  }))

  return { entries, defaultQueue: options.defaultQueue }
}

export async function generateRegistryTemplate(options: ModuleOptions, rootDir: string, templateDir: string): Promise<string> {
  return renderRegistryTemplate(await buildRegistryPlan(options, rootDir, templateDir))
}

export async function generateRegistryTypesTemplate(options: ModuleOptions, rootDir: string, templateDir: string): Promise<string> {
  return renderRegistryTypesTemplate(await buildRegistryPlan(options, rootDir, templateDir))
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
    `import { useRuntimeConfig } from 'nitropack/runtime'`,
    `import { createGeneratedCfJobsApp } from 'nuxt-cf-jobs/server'`,
    '',
    'export const jobs = [',
    ...entryLines,
    ']',
    `/** @type {import('nuxt-cf-jobs/server').CfJobsApp<${jobsType}>} */`,
    `export const app = createGeneratedCfJobsApp(jobs, useRuntimeConfig, ${plan.defaultQueue ? JSON.stringify(plan.defaultQueue) : 'undefined'})`,
    '',
    'export const {',
    ...cfJobsAppExportNames.map(name => `  ${name},`),
    '} = app',
    '',
  ].join('\n')
}

function renderRegistryTypesTemplate(plan: RegistryBuildPlan): string {
  const jobTypeLines = plan.entries.map((entry) => {
    return `    typeof import(${JSON.stringify(entry.importPath)})['default'],`
  })

  return [
    '/* This file is generated by nuxt-cf-jobs. Do not edit directly. */',
    `import type { BroadcastEnvelopeOf, BroadcastMessageOf, JobBroadcastEnvelopeByName, JobBroadcastMessageByName, JobMessageByName, JobMessageByQueue, JobNameOf, JobPayloadOf, JobQueueByName, QueueNameOf } from 'nuxt-cf-jobs/server'`,
    '',
    `declare module '#cf-jobs/app' {`,
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
