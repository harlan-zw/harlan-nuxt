import type { ModuleOptions } from './types'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { resolveFiles } from '@nuxt/kit'

export interface DiscoveredTask {
  /** Declared task name (nitro registers `nitro.tasks[name]`). */
  name: string
  /** Cron expression(s) declared via `defineScheduledTask`. Empty for plain `defineTask`. */
  crons: string[]
  /** Absolute source file path. */
  file: string
  /** Module path nitro registers as the task handler (absolute, extensionless). */
  handler: string
}

export async function resolveTaskFiles(options: ModuleOptions, rootDir: string): Promise<string[]> {
  // module.ts resolves `tasksDir: true` (auto-discover) into a concrete array
  // before calling; a bare boolean here just falls back to the convention dir.
  const raw = options.tasksDir
  const dirs = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : ['server/tasks']
  const pattern = options.tasksPattern ?? '**/*.ts'
  const ignore = options.tasksIgnore ?? ['**/_*.ts', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts']
  const files = await Promise.all(dirs.map((dir) => {
    const resolvedDir = resolve(rootDir, dir)
    if (!existsSync(resolvedDir))
      return []
    return resolveFiles(resolvedDir, pattern, { ignore })
  }))
  // Dedupe — overlapping dirs (e.g. a parent + child) would otherwise list a
  // file twice and trip the duplicate-name guard.
  return [...new Set(files.flat())]
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, (_m, prefix) => prefix)
}

// A single/double/backtick string literal; group 2 is the inner content.
// Hoisted to module scope (compiled once).
const STRING_LITERAL_SRC = `(['"\`])((?:[^'"\`\\\\]|\\\\.)*)\\1`
const NAME_RE = new RegExp(`\\bname\\s*:\\s*${STRING_LITERAL_SRC}`)
const CRON_SINGLE_RE = new RegExp(`\\bcron\\s*:\\s*${STRING_LITERAL_SRC}`)
const CRON_ARRAY_RE = /\bcron\s*:\s*\[([\s\S]*?)\]/
const STRING_LITERAL_G = new RegExp(STRING_LITERAL_SRC, 'g')

/**
 * Statically read the declared `name` and `cron` from a task source file
 * without executing it (task files import db/server utils that won't load
 * outside the nitro graph). Both must be string literals; computed values are
 * not resolvable at build time and are reported by the caller.
 */
export function parseTaskSource(source: string): { name?: string, crons: string[] } {
  const clean = stripComments(source)

  // First `name:` literal — for `defineScheduledTask({ name })` and for
  // `defineTask({ meta: { name } })` (meta.name is the first occurrence).
  const name = clean.match(NAME_RE)?.[2]

  const crons: string[] = []
  const arrayMatch = clean.match(CRON_ARRAY_RE)
  if (arrayMatch) {
    for (const m of arrayMatch[1]!.matchAll(STRING_LITERAL_G))
      crons.push(m[2]!)
  }
  else {
    const single = clean.match(CRON_SINGLE_RE)?.[2]
    if (single)
      crons.push(single)
  }

  return { name, crons }
}

export interface CollectTasksResult {
  tasks: DiscoveredTask[]
  /** Files that declared a cron but whose name could not be statically read. */
  unnamed: string[]
  /** Files that matched the scan but declared neither a name nor a cron. */
  skipped: string[]
}

export async function collectTasks(options: ModuleOptions, rootDir: string): Promise<CollectTasksResult> {
  const files = await resolveTaskFiles(options, rootDir)
  const tasks: DiscoveredTask[] = []
  const unnamed: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const { name, crons } = parseTaskSource(source)
    if (!name) {
      // A cron with no parseable name is a real misconfiguration; a file with
      // neither is just not a task (helper, etc).
      if (crons.length)
        unnamed.push(file)
      else
        skipped.push(file)
      continue
    }
    tasks.push({ name, crons, file, handler: file.replace(/\.[cm]?tsx?$/, '') })
  }

  return { tasks, unnamed, skipped }
}

export function findDuplicateTaskNames(tasks: readonly DiscoveredTask[]): string[] {
  const seen = new Map<string, string>()
  const dupes: string[] = []
  for (const t of tasks) {
    const prev = seen.get(t.name)
    if (prev)
      dupes.push(`${t.name} (${relative(process.cwd(), prev)}, ${relative(process.cwd(), t.file)})`)
    else
      seen.set(t.name, t.file)
  }
  return dupes
}

/**
 * Build `nitro.scheduledTasks` (`{ [cron]: taskName[] }`) from discovered tasks,
 * merged on top of any existing map. Names are deduped per cron.
 */
export function buildScheduledTasks(
  tasks: readonly DiscoveredTask[],
  existing: Record<string, string[]> = {},
): Record<string, string[]> {
  const out: Record<string, Set<string>> = {}
  for (const [cron, names] of Object.entries(existing))
    out[cron] = new Set(names)
  for (const t of tasks) {
    for (const cron of t.crons)
      (out[cron] ??= new Set()).add(t.name)
  }
  return Object.fromEntries(Object.entries(out).map(([cron, names]) => [cron, [...names]]))
}

/** Sorted, deduped union of every declared cron — the wrangler `triggers.crons`. */
export function buildCronUnion(tasks: readonly DiscoveredTask[], existing: readonly string[] = []): string[] {
  return [...new Set([...existing, ...tasks.flatMap(t => t.crons)])].sort()
}
