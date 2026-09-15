import type { ExternalCheckEvent, ExternalOptions } from '../runtime/external/index'
import type { Check, CheckReport } from '../runtime/server/index'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { loadNuxt } from '@nuxt/kit'
import { runExternalChecks } from '../runtime/external/index'

interface CliDependencies {
  cwd?: string
  env?: Record<string, string | undefined>
  clock?: () => Date
  stdout?: (text: string) => void
}
async function readState(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (text === null)
    return null
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Saved check state is invalid.')
  return value as Record<string, unknown>
}
async function atomicWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd()
  const env = dependencies.env ?? process.env
  const clock = dependencies.clock ?? (() => new Date())
  const stdout = dependencies.stdout ?? (text => process.stdout.write(text))
  let rootDir = cwd
  let artifact: string | undefined
  let save = false
  let prepare = false
  let since: Date | undefined
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--save') {
      save = true
    }
    else if (argument === 'prepare') {
      prepare = true
    }
    else if (argument === '--cwd' || argument === '--artifact' || argument === '--since') {
      const value = args[++index]
      if (!value)
        throw new Error(`${argument} requires a value.`)
      if (argument === '--cwd') {
        rootDir = resolve(cwd, value)
      }
      else if (argument === '--artifact') {
        artifact = resolve(cwd, value)
      }
      else {
        since = new Date(value)
        if (!Number.isFinite(since.getTime()))
          throw new Error('Check start time is invalid.')
      }
    }
    else if (argument === '--help') {
      stdout('nuxt-checkin [prepare] [--cwd path] [--artifact path] [--since ISO] [--save]\n')
      return 0
    }
    else {
      throw new Error(`Unknown check option: ${argument}`)
    }
  }
  if (prepare) {
    const nuxt = await loadNuxt({ cwd: rootDir, dev: false })
    await nuxt.close()
    return 0
  }
  // Generated checks are imported only in Node. The server registry never enters this artifact.
  const locator = artifact ? null : await readState(resolve(rootDir, 'node_modules/.cache/nuxt-checkin/artifact.json'))
  const locatedArtifact = typeof locator?.path === 'string' ? locator.path : resolve(rootDir, '.nuxt/checkin/external.mjs')
  const loaded = await import(pathToFileURL(artifact ?? locatedArtifact).href) as { default: readonly Check<ExternalCheckEvent>[], options: ExternalOptions }
  const now = clock()
  const directory = loaded.options.save ? resolve(rootDir, env[loaded.options.save.dirEnv ?? ''] || loaded.options.save.dir) : undefined
  const statePath = directory && loaded.options.save?.stateFile ? resolve(directory, loaded.options.save.stateFile) : undefined
  const previous = statePath ? await readState(statePath) : null
  const timestampKey = loaded.options.save?.timestampKey ?? 'observedAt'
  if (!since && previous) {
    const timestamp = previous[timestampKey]
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))
      throw new Error('Saved check timestamp is invalid.')
    since = new Date(timestamp)
  }
  if (since && since.getTime() > now.getTime())
    throw new Error('Check start time is in the future.')
  const { report, exitCode } = await runExternalChecks(loaded.default, loaded.options, { rootDir, env, clock, now, since, previous })
  if (save) {
    if (!directory)
      throw new Error('Check archive directory is not configured.')
    await saveReport(directory, report)
    // Daily comparisons need the previous complete observation, even when unhealthy.
    // The latest policy keeps its existing last-passing-report contract.
    const advance = loaded.options.save?.baseline === 'daily' ? report.coverage === 'complete' : exitCode === 0
    if (statePath && advance) {
      const sameDay = typeof previous?.[timestampKey] === 'string' && (previous[timestampKey] as string).slice(0, 10) === report.observedAt.slice(0, 10)
      if (loaded.options.save?.baseline !== 'daily' || !sameDay)
        await atomicWrite(statePath, { ...report, [timestampKey]: report.observedAt })
    }
  }
  stdout(`${JSON.stringify(report, null, 2)}\n`)
  return exitCode
}
async function saveReport(directory: string, report: CheckReport) {
  const name = `${report.observedAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`
  await atomicWrite(resolve(directory, name), report)
}
