import type { MeasuredTarget } from './rollup'
import type { BudgetScope } from './scope'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { displayId } from './report'
import { isBudgetScope } from './scope'

/**
 * Bumped whenever the shape changes, so `compare` refuses a report it cannot read.
 * Format 3 keys entries by a workspace-relative path, where format 2 left every entry
 * above the app root absolute and so machine-specific.
 */
export const SNAPSHOT_VERSION = 3

/**
 * Where the report lands, relative to the app root. Not `nuxt.options.buildDir`: that
 * moved into `node_modules/.cache` in Nuxt 4.5, which is no place to point a CI step at.
 */
export const SNAPSHOT_FILE = '.nuxt/dx/size-budget.json'

/**
 * The path a build should write to, or nothing when the report is off. Reporting is
 * opt-in: a build that nobody asked for a report from writes no files.
 */
export function resolveReportPath(option: boolean | { path?: string } | undefined): string | undefined {
  if (!option)
    return undefined
  return (option === true ? undefined : option.path) ?? SNAPSHOT_FILE
}

export interface SnapshotEntry {
  scope: BudgetScope
  /**
   * The module name, or the name a plugin declares. Absent for anything identified
   * only by its file, which is every plugin whose budget was never at risk.
   */
  name?: string
  /** Nuxt module that registered this runtime entry, when known. */
  owner?: string
  /** Workspace-relative file or package path, so two checkouts of the same repo agree. */
  path: string
  /** Bytes of the target's own bundled files. */
  ownBytes: number
  /** Bytes of the modules reachable only through this target. */
  exclusiveBytes: number
  totalBytes: number
}

export interface SizeBudgetSnapshot {
  version: number
  entries: SnapshotEntry[]
}

/** Identity across two builds: the name when the target has one, otherwise its path. */
export function entryKey(entry: Pick<SnapshotEntry, 'scope' | 'name' | 'path'>): string {
  return `${entry.scope}:${entry.name ?? entry.path}`
}

function toEntry(scope: BudgetScope, target: MeasuredTarget, baseDir: string): SnapshotEntry {
  const { ownBytes, exclusiveBytes, totalBytes } = target.measurement
  return {
    scope,
    ...(target.name === undefined ? {} : { name: target.name }),
    ...(target.owner === undefined ? {} : { owner: target.owner }),
    path: displayId(target.path, baseDir),
    ownBytes,
    exclusiveBytes,
    totalBytes,
  }
}

/**
 * Accumulates the measurements of every scope into one file. The scopes finish at
 * different times (the client bundle first, Nitro after it), so each pass rewrites
 * the whole report rather than waiting for a build-wide hook that a failed budget
 * would never reach.
 */
export function createSnapshotWriter(file: string, baseDir: string) {
  const byScope = new Map<BudgetScope, SnapshotEntry[]>()
  return async (scope: BudgetScope, measured: readonly MeasuredTarget[]): Promise<void> => {
    byScope.set(scope, measured.map(target => toEntry(scope, target, baseDir)))
    const entries = [...byScope.values()]
      .flat()
      .sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ version: SNAPSHOT_VERSION, entries } satisfies SizeBudgetSnapshot, null, 2)}\n`, 'utf-8')
  }
}

function isEntry(value: unknown): value is SnapshotEntry {
  if (typeof value !== 'object' || value === null)
    return false
  const entry = value as Record<string, unknown>
  return isBudgetScope(entry.scope)
    && typeof entry.path === 'string'
    && (entry.name === undefined || typeof entry.name === 'string')
    && (entry.owner === undefined || typeof entry.owner === 'string')
    && ['ownBytes', 'exclusiveBytes', 'totalBytes'].every(field => typeof entry[field] === 'number')
}

/** Reads a report written by another build, which may be any file the user pointed at. */
export function parseSnapshot(source: string, label: string): SizeBudgetSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    throw new Error(`${label} is not valid JSON.`)
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error(`${label} is not a size budget report.`)
  const { version, entries } = parsed as Record<string, unknown>
  if (version !== SNAPSHOT_VERSION)
    throw new Error(`${label} was written in format ${String(version)}, this CLI reads format ${SNAPSHOT_VERSION}. Rebuild it with a matching nuxt-dx.`)
  if (!Array.isArray(entries) || !entries.every(isEntry))
    throw new Error(`${label} has entries this CLI cannot read.`)
  return { version, entries }
}
