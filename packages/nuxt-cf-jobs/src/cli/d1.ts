/**
 * Runs SQL against a Cloudflare D1 database by shelling out to
 * `wrangler d1 execute`. This is the one portable path that works against both
 * the local miniflare database (`--local`, default) and production (`--remote`),
 * so the same CLI can debug live backpressure.
 *
 * `wrangler d1 execute --command` has no bind-parameter channel; callers build
 * SQL through `./queries`, which inlines and escapes any user input.
 */
import type { WranglerConfig, WranglerD1Database } from '../wrangler'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { findWranglerConfig, parseWranglerConfig } from '../wrangler'

const execFileAsync = promisify(execFile)
const JSON_START_RE = /[[{]/
const TRAILING_SEMICOLON_RE = /;\s*$/

export interface D1Target {
  /** `database_name` (or id) passed to `wrangler d1 execute <database>`. */
  database: string
  binding: string
  remote: boolean
  configPath?: string
  cwd: string
}

export class D1ResolutionError extends Error {}

/**
 * Pick which `[[d1_databases]]` entry to query. Prefers an explicit binding;
 * otherwise requires exactly one candidate so the target is never ambiguous.
 */
export function selectD1Database(databases: readonly WranglerD1Database[], binding?: string): WranglerD1Database {
  if (databases.length === 0)
    throw new D1ResolutionError('No [[d1_databases]] found in your wrangler config. Add a D1 binding, or pass --db.')
  if (binding) {
    const match = databases.find(d => d.binding === binding)
    if (!match)
      throw new D1ResolutionError(`No D1 binding "${binding}". Available: ${databases.map(d => d.binding).join(', ')}.`)
    return match
  }
  if (databases.length > 1)
    throw new D1ResolutionError(`Multiple D1 bindings (${databases.map(d => d.binding).join(', ')}). Pass --db to choose one.`)
  return databases[0]!
}

export interface ResolveD1Options {
  cwd?: string
  configPath?: string
  binding?: string
  remote?: boolean
}

/** Locate the wrangler config, parse its D1 bindings, and resolve a query target. */
export function resolveD1Target(opts: ResolveD1Options = {}): D1Target {
  const cwd = opts.cwd ?? process.cwd()
  const configPath = opts.configPath
    ? resolve(cwd, opts.configPath)
    : findWranglerConfig(cwd)
  if (!configPath)
    throw new D1ResolutionError(`No wrangler.{toml,jsonc,json} found in ${cwd}. Pass --config <path>.`)
  const config: WranglerConfig = parseWranglerConfig(configPath)
  const db = selectD1Database(config.d1Databases ?? [], opts.binding)
  return {
    database: db.databaseName ?? db.databaseId ?? db.binding,
    binding: db.binding,
    remote: opts.remote ?? false,
    configPath,
    cwd,
  }
}

function resolveWranglerBin(cwd: string): string {
  if (process.env.CF_JOBS_WRANGLER_BIN)
    return process.env.CF_JOBS_WRANGLER_BIN
  const local = resolve(cwd, 'node_modules/.bin/wrangler')
  return existsSync(local) ? local : 'wrangler'
}

interface WranglerD1Result<T> {
  results?: T[]
  success?: boolean
  meta?: Record<string, unknown>
}

/**
 * wrangler may prepend an install/skills banner to stdout even with `--json`;
 * pull out the JSON array/object payload rather than trusting the whole stream
 * to parse. Returns undefined when no JSON payload is present.
 */
function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed)
  }
  catch {
    const start = trimmed.search(JSON_START_RE)
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'))
    if (start === -1 || end <= start)
      return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    catch {
      return undefined
    }
  }
}

/** wrangler reports SQL errors as `{ error: { text } }` on stdout, exit 1. */
function wranglerErrorText(payload: unknown): string | undefined {
  const err = (payload as { error?: { text?: unknown } })?.error
  return err && typeof err.text === 'string' ? err.text : undefined
}

/**
 * Run one `wrangler d1 execute` and return its parsed statement-result entries.
 * Each `;`-separated statement yields one entry in declaration order.
 *
 * All SQL goes through a single subprocess: the local miniflare D1 throws an
 * opaque "internal error" under concurrent access, so callers must never run
 * two `wrangler d1 execute` processes against the same database in parallel.
 */
async function runD1<T>(target: D1Target, sql: string): Promise<WranglerD1Result<T>[]> {
  const bin = resolveWranglerBin(target.cwd)
  const args = ['d1', 'execute', target.database, target.remote ? '--remote' : '--local', '--json', '--command', sql]
  if (target.configPath)
    args.push('--config', target.configPath)

  const result = await execFileAsync(bin, args, {
    cwd: target.cwd,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
  }).catch((error: { stdout?: string, stderr?: string, message?: string }) => {
    // wrangler surfaces SQL errors as a JSON `{ error: { text } }` on stdout
    // with a non-zero exit; prefer that over execFile's opaque "Command failed".
    const sqlError = wranglerErrorText(extractJson(error.stdout ?? ''))
    const detail = (sqlError || error.stderr || error.message || '').trim()
    throw new Error(`wrangler d1 execute failed:\n${detail}`)
  })

  const parsed = extractJson(result.stdout)
  if (parsed === undefined)
    throw new Error(`Could not parse wrangler JSON output:\n${result.stdout}`)
  const sqlError = wranglerErrorText(parsed)
  if (sqlError)
    throw new Error(`wrangler d1 execute failed:\n${sqlError}`)
  return (Array.isArray(parsed) ? parsed : [parsed]) as WranglerD1Result<T>[]
}

/** Execute SQL and return the flattened result rows across all statements. */
export async function execD1<T = Record<string, unknown>>(target: D1Target, sql: string): Promise<T[]> {
  const entries = await runD1<T>(target, sql)
  return entries.flatMap(e => e.results ?? [])
}

/**
 * Execute several independent statements in one subprocess and return their
 * result sets positionally. Use this instead of `Promise.all([execD1, …])` —
 * parallel subprocesses corrupt the local D1.
 */
export async function execD1Batch<T = Record<string, unknown>>(target: D1Target, sqls: string[]): Promise<T[][]> {
  if (sqls.length === 0)
    return []
  const entries = await runD1<T>(target, sqls.map(s => s.trim().replace(TRAILING_SEMICOLON_RE, '')).join(';\n'))
  return sqls.map((_, i) => entries[i]?.results ?? [])
}
