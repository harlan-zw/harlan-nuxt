#!/usr/bin/env node
/**
 * `cf-jobs` — a Laravel-`artisan`-style CLI for inspecting and managing the
 * durable D1 job tables this module writes. Read commands surface live
 * backpressure (queue depth, ready/reserved/delayed splits, ready-lag, failures)
 * straight from D1 via `wrangler d1 execute`; mutating commands mirror
 * `queue:retry` / `queue:forget` / `queue:flush` / `queue:clear`.
 */
import type { ArgsDef, CommandDef } from 'citty'
import type { D1DatabaseLike, D1PreparedStatementLike } from '../runtime/server/d1'
import type { ModuleOptions } from '../types'
import type { JobState } from './queries'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { findProjectWranglerConfig } from '@harlan-zw/nuxt-cloudflare/wrangler'
import { defineCommand, runMain } from 'citty'
import { d1DurableJobMigrationSql } from '../runtime/server/d1'
import { recentTerminalJobs, snapshotDurableQueues } from '../runtime/server/dev-worker-snapshot'
import { collectTasks } from '../tasks'
import { parseWranglerConfig } from '../wrangler'
import { D1ResolutionError, execD1, execD1Batch, resolveD1Target } from './d1'
import {
  activeJobsSql,
  backpressureSql,
  clearSql,
  defaultTableNames,
  failedCountSql,
  failedJobsSql,
  flushSql,
  forgetSql,
  pruneSql,
  retrySql,
  staleReservedSql,
  summarizeBackpressure,
} from './queries'
import { color, humanizeSeconds, nextCronRun, relativeTime, table, truncate } from './render'

const CONFIRM_YES_RE = /^y(?:es)?$/i

const sharedArgs = {
  'cwd': { type: 'string', description: 'Project directory (default: current dir)' },
  'config': { type: 'string', description: 'Path to wrangler config (default: auto-detect)' },
  'db': { type: 'string', description: 'D1 binding name to query (default: the only binding)' },
  'remote': { type: 'boolean', description: 'Query the production (remote) D1 — default is local', default: false },
  'jobs-table': { type: 'string', description: 'Override the jobs table name', default: defaultTableNames.jobs },
  'failed-table': { type: 'string', description: 'Override the failed-jobs table name', default: defaultTableNames.failed },
  'json': { type: 'boolean', description: 'Output raw JSON', default: false },
} satisfies ArgsDef

type SharedArgs = {
  [K in keyof typeof sharedArgs]: typeof sharedArgs[K] extends { type: 'boolean' } ? boolean : string | undefined
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function context(args: SharedArgs) {
  const target = resolveD1Target({ cwd: args.cwd, configPath: args.config, binding: args.db, remote: args.remote })
  const tables = { jobs: args['jobs-table']!, failed: args['failed-table']!, batches: defaultTableNames.batches }
  return { target, tables }
}

function out(json: boolean, data: unknown, render: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${render()}\n`)
}

async function confirm(message: string, skip: boolean): Promise<boolean> {
  if (skip)
    return true
  if (!process.stdin.isTTY) {
    process.stderr.write('Refusing to mutate without a TTY. Re-run with --yes to confirm.\n')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await rl.question(`${message} ${color.dim('[y/N]')} `)
  rl.close()
  return CONFIRM_YES_RE.test(answer.trim())
}

const status = defineCommand({
  meta: { name: 'status', description: 'Queue backpressure overview (ready/reserved/delayed, lag, failures)' },
  args: sharedArgs,
  async run({ args }) {
    await runStatus(args as SharedArgs)
  },
})

async function runStatus(args: SharedArgs): Promise<void> {
  const { target, tables } = context(args)
  const now = nowSeconds()
  // One subprocess for all three reads — parallel wrangler processes corrupt the local D1.
  const [rows, failed, stale] = await execD1Batch<any>(target, [
    backpressureSql(tables),
    failedCountSql(tables),
    staleReservedSql(300, tables),
  ]) as [Parameters<typeof summarizeBackpressure>[0][number][], Array<{ queue: string, total: number }>, Array<{ total: number }>]
  const summary = summarizeBackpressure(rows, now)
  const failedTotal = failed.reduce((n, r) => n + Number(r.total), 0)
  const staleTotal = Number(stale[0]?.total ?? 0)

  out(args.json, { ...summary, failed, failedTotal, staleReserved: staleTotal, scope: target.remote ? 'remote' : 'local' }, () => {
    if (summary.queues.length === 0)
      return color.dim(`No active jobs in ${target.binding} (${target.remote ? 'remote' : 'local'}).`)
    const body = table(
      ['QUEUE', 'TOTAL', 'READY', 'RESERVED', 'DELAYED', 'LAG'],
      summary.queues.map(q => [
        q.queue,
        q.total,
        q.ready > 0 ? color.yellow(q.ready) : '0',
        q.reserved,
        q.delayed,
        q.lagSeconds > 0 ? color.yellow(humanizeSeconds(q.lagSeconds)) : '—',
      ]),
      [false, true, true, true, true, true],
    )
    const lines = [
      color.bold(`D1: ${target.binding} (${target.remote ? color.magenta('remote') : color.cyan('local')})`),
      body,
      '',
      `${color.bold('Totals')}  ready ${summary.totals.ready}  reserved ${summary.totals.reserved}  delayed ${summary.totals.delayed}  failed ${failedTotal > 0 ? color.red(failedTotal) : 0}`,
    ]
    if (summary.maxLagSeconds > 0)
      lines.push(color.yellow(`Worst ready-lag: ${humanizeSeconds(summary.maxLagSeconds)} — jobs are waiting longer than expected.`))
    if (staleTotal > 0)
      lines.push(color.red(`${staleTotal} reserved job(s) stuck >5m — likely a crashed/timed-out consumer. Try \`cf-jobs clear --state reserved\` or wait for recovery.`))
    return lines.join('\n')
  })
}

function parseState(value: string | undefined): JobState | undefined {
  if (value == null)
    return undefined
  if (['ready', 'reserved', 'delayed', 'completed'].includes(value))
    return value as JobState
  throw new Error(`Invalid --state "${value}". Use ready | reserved | delayed | completed.`)
}

const jobs = defineCommand({
  meta: { name: 'jobs', description: 'List active jobs (filter by queue/type/state)' },
  args: {
    ...sharedArgs,
    queue: { type: 'string', description: 'Filter by logical queue' },
    type: { type: 'string', description: 'Filter by job_type' },
    state: { type: 'string', description: 'ready | reserved | delayed | completed' },
    limit: { type: 'string', description: 'Max rows', default: '50' },
  },
  async run({ args }) {
    const { target, tables } = context(args as SharedArgs)
    const now = nowSeconds()
    const rows = await execD1<Record<string, any>>(target, activeJobsSql({
      queue: args.queue,
      type: args.type,
      state: parseState(args.state),
      limit: Number(args.limit),
    }, tables))
    out(args.json, rows, () => {
      if (rows.length === 0)
        return color.dim('No matching jobs.')
      return table(
        ['ID', 'QUEUE', 'TYPE', 'ATT', 'STATE', 'AVAILABLE', 'SITE'],
        rows.map(r => [
          truncate(r.id, 12),
          truncate(r.queue, 16),
          truncate(r.job_type, 22),
          `${r.attempts}/${r.max_attempts}`,
          r.reserved_at ? color.cyan('reserved') : Number(r.available_at) > now ? 'delayed' : color.yellow('ready'),
          relativeTime(Number(r.available_at), now),
          truncate(r.site_id ?? '', 14),
        ]),
        [false, false, false, true, false, false, false],
      )
    })
  },
})

const failed = defineCommand({
  meta: { name: 'failed', description: 'List failed jobs (artisan queue:failed)' },
  args: {
    ...sharedArgs,
    queue: { type: 'string', description: 'Filter by logical queue' },
    type: { type: 'string', description: 'Filter by job_type' },
    limit: { type: 'string', description: 'Max rows', default: '50' },
  },
  async run({ args }) {
    const { target, tables } = context(args as SharedArgs)
    const now = nowSeconds()
    const rows = await execD1<Record<string, any>>(target, failedJobsSql({
      queue: args.queue,
      type: args.type,
      limit: Number(args.limit),
    }, tables))
    out(args.json, rows, () => {
      if (rows.length === 0)
        return color.dim('No failed jobs. 🎉')
      return table(
        ['ID', 'QUEUE', 'TYPE', 'ATT', 'FAILED', 'EXCEPTION'],
        rows.map(r => [
          truncate(r.id, 12),
          truncate(r.queue, 16),
          truncate(r.job_type, 20),
          `${r.attempts}/${r.max_attempts}`,
          relativeTime(Number(r.failed_at), now),
          color.red(truncate(String(r.exception ?? '').split('\n')[0], 40)),
        ]),
        [false, false, false, true, false, false],
      )
    })
  },
})

const retry = defineCommand({
  meta: { name: 'retry', description: 'Re-queue failed jobs by id, queue, or --all (artisan queue:retry)' },
  args: {
    ...sharedArgs,
    id: { type: 'positional', description: 'Failed job id', required: false },
    queue: { type: 'string', description: 'Re-queue all failures in this queue' },
    all: { type: 'boolean', description: 'Re-queue every failed job', default: false },
    yes: { type: 'boolean', alias: 'y', description: 'Skip confirmation', default: false },
  },
  async run({ args }) {
    const { target, tables } = context(args as SharedArgs)
    if (!args.id && !args.queue && !args.all)
      throw new Error('Pass a job id, --queue <name>, or --all.')
    const scope = args.id ? `job ${args.id}` : args.queue ? `all failures in "${args.queue}"` : 'ALL failed jobs'
    if (!(await confirm(`Re-queue ${scope}?`, args.yes)))
      return
    await execD1(target, retrySql({ id: args.id, queue: args.queue, all: args.all }, tables))
    process.stdout.write(`${color.green('✓')} Re-queued ${scope}.\n`)
  },
})

const forget = defineCommand({
  meta: { name: 'forget', description: 'Delete a single failed job (artisan queue:forget)' },
  args: {
    ...sharedArgs,
    id: { type: 'positional', description: 'Failed job id', required: true },
    yes: { type: 'boolean', alias: 'y', description: 'Skip confirmation', default: false },
  },
  async run({ args }) {
    const { target, tables } = context(args as SharedArgs)
    if (!(await confirm(`Delete failed job ${args.id}?`, args.yes)))
      return
    await execD1(target, forgetSql(args.id, tables))
    process.stdout.write(`${color.green('✓')} Deleted failed job ${args.id}.\n`)
  },
})

const flush = defineCommand({
  meta: { name: 'flush', description: 'Delete all failed jobs (artisan queue:flush)' },
  args: {
    ...sharedArgs,
    queue: { type: 'string', description: 'Only flush failures in this queue' },
    yes: { type: 'boolean', alias: 'y', description: 'Skip confirmation', default: false },
  },
  async run({ args }) {
    const { target, tables } = context(args as SharedArgs)
    const scope = args.queue ? `failures in "${args.queue}"` : 'ALL failed jobs'
    if (!(await confirm(`Flush ${scope}?`, args.yes)))
      return
    await execD1(target, flushSql(args.queue, tables))
    process.stdout.write(`${color.green('✓')} Flushed ${scope}.\n`)
  },
})

const clear = defineCommand({
  meta: { name: 'clear', description: 'Delete active (incomplete) jobs (artisan queue:clear)' },
  args: {
    ...sharedArgs,
    queue: { type: 'string', description: 'Only clear this queue' },
    state: { type: 'string', description: 'Only clear ready | reserved | delayed jobs' },
    yes: { type: 'boolean', alias: 'y', description: 'Skip confirmation', default: false },
  },
  async run({ args }) {
    const { target, tables } = context(args as SharedArgs)
    const state = parseState(args.state)
    const scope = [args.state, args.queue ? `"${args.queue}"` : 'all queues'].filter(Boolean).join(' jobs in ')
    if (!(await confirm(`Clear ${scope} (${target.remote ? 'remote' : 'local'})?`, args.yes)))
      return
    await execD1(target, clearSql({ queue: args.queue, state }, tables))
    process.stdout.write(`${color.green('✓')} Cleared ${scope}.\n`)
  },
})

const prune = defineCommand({
  meta: { name: 'prune', description: 'Delete terminal rows past retention (artisan queue:prune-batches + queue:prune-failed)' },
  args: {
    ...sharedArgs,
    'completed-hours': { type: 'string', description: 'Completed-jobs retention in hours', default: '24' },
    'failed-hours': { type: 'string', description: 'Failed-jobs retention in hours', default: '168' },
    'batches-hours': { type: 'string', description: 'Finished-batches retention in hours', default: '72' },
    'yes': { type: 'boolean', alias: 'y', description: 'Skip confirmation', default: false },
  },
  async run({ args }) {
    const { target, tables } = context(args as SharedArgs)
    const hours = {
      completedHours: Number(args['completed-hours']),
      failedHours: Number(args['failed-hours']),
      batchesHours: Number(args['batches-hours']),
    }
    if (Object.values(hours).some(h => !Number.isFinite(h) || h < 0)) {
      process.stderr.write(`${color.red('✗')} --*-hours must be non-negative numbers.\n`)
      process.exitCode = 1
      return
    }
    const scope = `completed >${hours.completedHours}h, failed >${hours.failedHours}h, batches >${hours.batchesHours}h`
    if (!(await confirm(`Prune ${scope} (${target.remote ? 'remote' : 'local'})?`, args.yes)))
      return
    await execD1(target, `${pruneSql(hours, tables)};`)
    process.stdout.write(`${color.green('✓')} Pruned ${scope}.\n`)
  },
})

const migrate = defineCommand({
  meta: { name: 'migrate', description: 'Create the job tables/indexes in D1' },
  args: {
    ...sharedArgs,
    yes: { type: 'boolean', alias: 'y', description: 'Skip confirmation', default: false },
  },
  async run({ args }) {
    const { target } = context(args as SharedArgs)
    if (!(await confirm(`Run migrations against ${target.binding} (${target.remote ? 'remote' : 'local'})?`, args.yes)))
      return
    await execD1(target, `${d1DurableJobMigrationSql.join(';\n')};`)
    process.stdout.write(`${color.green('✓')} Migrated ${target.binding}.\n`)
  },
})

const taskScanArgs = {
  'cwd': { type: 'string', description: 'Project directory (default: current dir)' },
  'tasks-dir': { type: 'string', description: 'Directory scanned for tasks', default: 'server/tasks' },
  'json': { type: 'boolean', description: 'Output raw JSON', default: false },
} satisfies ArgsDef

function taskOptions(args: { 'tasks-dir'?: string }): ModuleOptions {
  return { queues: {}, tasksDir: args['tasks-dir'] ?? 'server/tasks' }
}

const schedule = defineCommand({
  meta: { name: 'schedule', description: 'List scheduled (cron) tasks with next run (artisan schedule:list)' },
  args: taskScanArgs,
  async run({ args }) {
    const cwd = args.cwd ?? process.cwd()
    const { tasks } = await collectTasks(taskOptions(args), cwd)
    const scheduled = tasks.filter(t => t.crons.length > 0)
    const from = new Date()
    const data = scheduled.flatMap(t => t.crons.map((cron) => {
      const next = nextCronRun(cron, from)
      return { name: t.name, cron, nextRun: next?.toISOString() ?? null }
    }))
    out(args.json, data, () => {
      if (data.length === 0)
        return color.dim(`No scheduled tasks under ${args['tasks-dir']}.`)
      const now = nowSeconds()
      return table(
        ['TASK', 'CRON', 'NEXT RUN (UTC)'],
        data.map(d => [
          d.name,
          color.cyan(d.cron),
          d.nextRun ? `${d.nextRun.replace('.000Z', 'Z')} ${color.dim(`(${relativeTime(Math.floor(Date.parse(d.nextRun) / 1000), now)})`)}` : color.red('unparseable'),
        ]),
      )
    })
  },
})

const tasks = defineCommand({
  meta: { name: 'tasks', description: 'List all discovered tasks (scheduled and on-demand)' },
  args: taskScanArgs,
  async run({ args }) {
    const cwd = args.cwd ?? process.cwd()
    const { tasks: discovered } = await collectTasks(taskOptions(args), cwd)
    out(args.json, discovered.map(t => ({ name: t.name, crons: t.crons })), () => {
      if (discovered.length === 0)
        return color.dim(`No tasks under ${args['tasks-dir']}.`)
      return table(
        ['TASK', 'CRONS'],
        discovered.map(t => [t.name, t.crons.length ? color.cyan(t.crons.join(', ')) : color.dim('on-demand')]),
      )
    })
  },
})

export interface QueueSnapshot {
  queue: string
  ready: number
  reserved: number
  delayed: number
  completed: number
  failed: number
  /** Wrangler consumer config the worker fans out against (present on the live endpoint). */
  maxConcurrency?: number
  maxBatchSize?: number
}

export interface RecentJob {
  id: string
  type: string
  queue: string
  outcome: 'completed' | 'failed'
  durationMs: number | null
  error: string | null
  /** Unix seconds the job reached its terminal state. */
  at: number
}

export interface WorkerDashboardState {
  host: string
  uptimeSeconds: number
  /** Unix seconds at render time, for relative "ago" rendering. */
  nowSeconds: number
  /** Jobs the worker has driven this session. */
  sessionProcessed: number
  /** Rolling jobs/sec. */
  ratePerSec: number
  /** In-flight drain lanes per queue (live fan-out). */
  inflight: Record<string, number>
  snapshot: QueueSnapshot[]
  recent: RecentJob[]
}

/** Throughput: whole numbers bare (`6`), otherwise one decimal (`2.4`), rounded above 10. */
function formatRate(rate: number): string {
  if (rate >= 10)
    return String(Math.round(rate))
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(1)
}

/** Compact job duration: 142ms, 1.2s, 45s. */
export function formatMs(ms: number | null): string {
  if (ms == null)
    return '—'
  if (ms < 1000)
    return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

/**
 * Render the full `cf-jobs work --watch` frame. Defined in the CLI entry module
 * (not `render.ts`) on purpose: rollup only traces the default `status` command
 * as live, so a helper reached solely through the `work` subcommand gets
 * tree-shaken out of the bundle while its call site survives — a runtime
 * `ReferenceError`. Keeping it entry-local with the `work` command avoids that.
 */
export function renderWorkerDashboard(s: WorkerDashboardState): string {
  const failedTotal = s.snapshot.reduce((n, q) => n + q.failed, 0)
  const lines: string[] = []

  lines.push([
    color.bold('cf-jobs work'),
    s.host,
    `up ${humanizeSeconds(s.uptimeSeconds)}`,
    `${s.sessionProcessed} done`,
    failedTotal > 0 ? color.red(`${failedTotal} failed`) : '0 failed',
    `~${formatRate(s.ratePerSec)}/s`,
  ].join(` ${color.dim('·')} `))
  lines.push('')

  if (s.snapshot.length === 0) {
    lines.push(color.dim('no durable jobs yet'))
  }
  else {
    lines.push(table(
      ['QUEUE', 'READY', 'LANES', 'DONE', 'FAIL'],
      s.snapshot.map((q) => {
        const lanes = s.inflight[q.queue] ?? 0
        const budget = q.maxConcurrency ?? 1
        return [
          q.queue,
          q.ready > 0 ? color.yellow(q.ready) : '0',
          lanes > 0 ? color.cyan(`${lanes}/${budget}`) : color.dim(`0/${budget}`),
          q.completed,
          q.failed > 0 ? color.red(q.failed) : '0',
        ]
      }),
      [false, true, true, true, true],
    ))
  }

  lines.push('')
  lines.push(color.dim('recent'))
  if (s.recent.length === 0) {
    lines.push(color.dim('  (nothing yet)'))
  }
  else {
    lines.push(table(
      ['', 'JOB', 'QUEUE', 'AGO', 'TOOK / ERROR'],
      s.recent.map(j => [
        j.outcome === 'completed' ? color.green('✓') : color.red('✗'),
        truncate(j.type, 24),
        truncate(j.queue, 14),
        relativeTime(j.at, s.nowSeconds),
        j.outcome === 'completed'
          ? formatMs(j.durationMs)
          : color.red(truncate((j.error ?? '').split('\n')[0], 36)),
      ]),
      [false, false, false, false, false],
    ))
  }

  return lines.join('\n')
}

interface WorkTickResult {
  processed: number
  byQueue?: Record<string, number>
  remaining: number
  error?: string
  ambiguousBindings?: string[]
  snapshot?: QueueSnapshot[]
  recent?: RecentJob[]
}

export interface LanePlan {
  queue: string
  /** How many new drain lanes to fire this round. */
  fire: number
  /** Messages per drain call (the queue's wrangler `max_batch_size`). */
  batchSize: number
}

/**
 * Demand-driven fan-out: for each queue with ready work and a free lane, decide how
 * many concurrent per-batch drains to fire. One poller, sized to each queue's
 * `maxConcurrency`, so a long job in one queue never starves the others.
 */
export function planDrainLanes(
  snapshot: QueueSnapshot[],
  inflight: Record<string, number>,
  opts: { onlyQueue?: string } = {},
): LanePlan[] {
  const plans: LanePlan[] = []
  for (const q of snapshot) {
    if (opts.onlyQueue && q.queue !== opts.onlyQueue)
      continue
    if (q.ready <= 0)
      continue
    const budget = Math.max(1, q.maxConcurrency ?? 1)
    const batchSize = Math.max(1, q.maxBatchSize ?? 10)
    // Don't open more lanes than there's work for, nor exceed the queue's budget.
    const wanted = Math.min(budget, Math.ceil(q.ready / batchSize))
    const fire = Math.max(0, wanted - (inflight[q.queue] ?? 0))
    if (fire > 0)
      plans.push({ queue: q.queue, fire, batchSize })
  }
  return plans
}

/** New terminal jobs not yet emitted, oldest-first (chronological), for the agent stream. */
export function selectNewTerminalJobs(recent: RecentJob[], seen: ReadonlySet<string>): RecentJob[] {
  return recent.filter(j => !seen.has(j.id)).sort((a, b) => a.at - b.at)
}

/** One NDJSON event line for an agent: failures carry the FULL untruncated error. */
export function formatWatchEvent(job: RecentJob): string {
  const ts = new Date(job.at * 1000).toISOString()
  return job.outcome === 'completed'
    ? JSON.stringify({ ts, event: 'completed', id: job.id, queue: job.queue, type: job.type, durationMs: job.durationMs })
    : JSON.stringify({ ts, event: 'failed', id: job.id, queue: job.queue, type: job.type, error: job.error })
}

const TRAILING_SLASH_RE = /\/+$/
const CURSOR_HIDE = '[?25l'
const CURSOR_SHOW = '[?25h'
const CLEAR_FROM_HOME = '[H[0J'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const WORK_ENDPOINT = '/__cf-jobs/work'

function buildUrl(base: string, params: Record<string, string>): string {
  return `${base}${WORK_ENDPOINT}?${new URLSearchParams(params)}`
}

/**
 * One POST to the work endpoint. Never throws and never hangs: an own
 * AbortController is aborted by either the shutdown `signal` (so Ctrl-C / a
 * scheduler exit drops the in-flight request immediately) or a per-request
 * timeout (so a half-dead server that accepts the socket but never responds
 * still resolves to `null`). The timeout uses an `unref`'d timer that's cleared
 * once the request settles — so a long timeout can never keep the process alive
 * past a request that already finished (unlike `AbortSignal.timeout`, which
 * can't be cleared).
 */
async function fetchTick(url: string, opts: { signal?: AbortSignal, timeoutMs?: number } = {}): Promise<WorkTickResult | null> {
  const { signal, timeoutMs = 0 } = opts
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted)
    controller.abort()
  else
    signal?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  timer?.unref?.()
  return await fetch(url, { method: 'POST', signal: controller.signal })
    .then(r => r.json() as Promise<WorkTickResult>)
    .catch((): WorkTickResult | null => null)
    .finally(() => {
      if (timer)
        clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    })
}

function hostOf(base: string): string {
  try {
    return new URL(base).host
  }
  catch {
    return base
  }
}

// --- Local D1 (dev) ----------------------------------------------------------
// `cf-jobs work`/`watch` discover demand by reading the local miniflare D1
// SQLite directly rather than polling the dev server, so an idle worker never
// touches it. Both commands are dev-only (they drive a running `nuxt dev`), so a
// local `.wrangler` database is expected.
//
// Defined entry-local (not a separate module) on purpose: rollup tree-shakes a
// "pure" cross-module helper like `openLocalD1` out of the CLI bundle while its
// call site survives — a runtime `ReferenceError`, the same trap documented on
// `renderWorkerDashboard`. (Throwing helpers like `findLocalD1Sqlite` survive;
// the connection-opening one doesn't.)
//
// Safe alongside the running dev server: we open `readOnly` and miniflare keeps
// the database in WAL mode, so a separate read-only connection never blocks or
// corrupts the writer. (The "no concurrent access" rule in `./d1` is about
// parallel `wrangler d1 execute` *writers*, not read-only readers.)

/** Where wrangler v3 persists each local D1 database (one `<hash>.sqlite` per binding, plus `metadata.sqlite`). */
const D1_STATE_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'

class LocalD1Error extends Error {}

/**
 * Locate the local D1 SQLite file under `.wrangler`. Errors (rather than falling
 * back to the server) when none exists. `dbFile` overrides auto-detection when
 * more than one binding's database is present.
 */
function findLocalD1Sqlite(cwd: string, dbFile?: string): string {
  if (dbFile) {
    const path = join(cwd, dbFile)
    if (!existsSync(path))
      throw new LocalD1Error(`--db-file not found: ${path}`)
    return path
  }
  const dir = join(cwd, D1_STATE_DIR)
  if (!existsSync(dir))
    throw new LocalD1Error(`No local D1 database found at ${D1_STATE_DIR}. Start \`nuxt dev\` once to create it (cf-jobs work/watch read it directly).`)
  const files = readdirSync(dir).filter(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
  if (files.length === 0)
    throw new LocalD1Error(`No D1 database file in ${D1_STATE_DIR}. Start \`nuxt dev\` once to create it.`)
  if (files.length > 1)
    throw new LocalD1Error(`Multiple D1 databases in ${D1_STATE_DIR} (${files.join(', ')}). Pass --db-file <name> to choose one.`)
  return join(dir, files[0]!)
}

/**
 * Open the local D1 SQLite as a read-only {@link D1DatabaseLike}, so the runtime
 * snapshot queries (`snapshotDurableQueues`, `recentTerminalJobs`) run unchanged
 * against it. Returns a `close()` to release the file handle.
 */
function openLocalD1(path: string): { db: D1DatabaseLike, close: () => void } {
  const sqlite = new DatabaseSync(path, { readOnly: true })
  // Wait briefly rather than throw SQLITE_BUSY if a checkpoint is mid-flight.
  sqlite.exec('PRAGMA busy_timeout = 2000')

  const statement = <T>(query: string, bound: readonly unknown[]): D1PreparedStatementLike<T> => ({
    bind: (...values: unknown[]) => statement<T>(query, values),
    run: async () => {
      const r = sqlite.prepare(query).run(...(bound as never[]))
      return { success: true, meta: { changes: Number(r.changes) } }
    },
    first: async <R = T>() => (sqlite.prepare(query).get(...(bound as never[])) as R | undefined) ?? null,
    all: async <R = T>() => ({ results: sqlite.prepare(query).all(...(bound as never[])) as R[] }),
  })

  const db: D1DatabaseLike = {
    exec: async (query: string) => sqlite.exec(query),
    prepare: <T>(query: string) => statement<T>(query, []),
  }
  return { db, close: () => sqlite.close() }
}

interface SchedulerContext {
  base: string
  host: string
  /** App root — where `.wrangler` and the wrangler config live. */
  cwd: string
  /** Override local D1 sqlite file selection when multiple databases exist. */
  dbFile?: string
  interval: number
  onlyQueue?: string
  db?: string
  recent: number
  once: boolean
  json: boolean
  watch: boolean
  stopped: () => boolean
  signal: AbortSignal
}

/** Refresh the dev-server worker lease at least this often (well under its 15s TTL). */
const LEASE_PING_MS = 10_000

/**
 * Per-queue lane sizing read from the wrangler consumer config. Best-effort: when
 * the config is missing/unparseable, `planDrainLanes` falls back to Cloudflare's
 * defaults (concurrency 1, batch 10), so an empty map is fine.
 */
function loadQueueSizing(cwd: string): Map<string, { maxConcurrency?: number, maxBatchSize?: number }> {
  const sizing = new Map<string, { maxConcurrency?: number, maxBatchSize?: number }>()
  const configPath = findProjectWranglerConfig(cwd)
  if (!configPath)
    return sizing
  try {
    for (const c of parseWranglerConfig(configPath).consumers ?? [])
      sizing.set(c.queue, { maxConcurrency: c.maxConcurrency, maxBatchSize: c.maxBatchSize })
  }
  catch {
    // Malformed wrangler config — fan-out just uses safe defaults.
  }
  return sizing
}

/** Read the live demand snapshot straight from local D1, enriched with lane sizing. */
async function readLocalSnapshot(
  db: D1DatabaseLike,
  sizing: Map<string, { maxConcurrency?: number, maxBatchSize?: number }>,
  recentLimit: number,
  sinceSeconds?: number,
): Promise<{ snapshot: QueueSnapshot[], recent: RecentJob[] }> {
  const [queues, recent] = await Promise.all([
    snapshotDurableQueues(db),
    recentTerminalJobs(db, { limit: recentLimit, sinceSeconds }),
  ])
  return {
    snapshot: queues.map(q => ({ ...q, ...sizing.get(q.queue) })),
    recent,
  }
}

/**
 * The lane scheduler: ONE poller that reads a cheap demand snapshot each interval
 * and fans out concurrent per-queue batch drains sized to each queue's
 * maxConcurrency. Lanes run async (never awaited in the loop) so a slow queue
 * never blocks the others. Renders the live dashboard (watch), a JSON line per
 * interval (--json), or a per-lane log (--no-watch).
 */
async function runScheduler(ctx: SchedulerContext): Promise<void> {
  const { db: localDb, close } = openLocalD1(findLocalD1Sqlite(ctx.cwd, ctx.dbFile))
  const sizing = loadQueueSizing(ctx.cwd)
  // Aborted on ANY scheduler exit (SIGINT or a normal/once return), so a lane
  // blocked on a half-dead server that accepts but never responds is dropped
  // immediately instead of pinning the process open until its timeout fires.
  const localAbort = new AbortController()
  const signal = AbortSignal.any([ctx.signal, localAbort.signal])
  const inflight: Record<string, number> = {}
  const rateWindow: Array<{ t: number, n: number }> = []
  const startedAt = Date.now()
  let sessionProcessed = 0
  let warnedSnapshot = false
  let serverDown = false // drain/lease endpoint unreachable — discovery still works off local D1
  let leaseAt = 0 // last dev-server lease refresh
  let idle = ctx.interval
  const maxIdleInterval = Math.max(ctx.interval, 3000)
  const repaint = (frame: string) => process.stdout.write(`${CLEAR_FROM_HOME}${frame}`)

  // The dev server is hit ONLY to drain and to keep the lease — never to discover
  // work (that's a local-D1 read). Track its reachability off those calls and
  // announce transitions once instead of one line per poll.
  const noteContact = (ok: boolean): void => {
    if (signal.aborted || ok === !serverDown)
      return // ignore aborted-request results during shutdown
    serverDown = !ok
    if (!ctx.watch && !ctx.json) {
      process.stderr.write(ok
        ? `${color.green('✓')} dev server reachable at ${ctx.host}\n`
        : `${color.yellow('…')} dev server unreachable at ${ctx.host} — discovering from local D1; draining resumes when it returns\n`)
    }
  }

  // Keep the dev-queues plugin deferring auto-dispatch to us: one cheap POST under
  // the 15s lease TTL. Without it an idle worker would let the lease lapse and the
  // dev server would start draining too (double execution).
  const refreshLease = async (now: number): Promise<void> => {
    if (now - leaseAt < LEASE_PING_MS)
      return
    leaseAt = now
    const params: Record<string, string> = { drain: '0' }
    if (ctx.db)
      params.db = ctx.db
    const res = await fetchTick(buildUrl(ctx.base, params), { signal, timeoutMs: 3000 })
    noteContact(res !== null)
  }

  // A self-sustaining lane: pulls a batch, and as soon as the response returns with
  // work, pulls the next one immediately — throughput is gated by how fast the
  // server drains, NOT by the snapshot poll clock. It closes when a batch comes
  // back empty (or errors); the snapshot loop reopens it if the queue refills.
  const openLane = (queue: string, batchSize: number) => {
    inflight[queue] = (inflight[queue] ?? 0) + 1
    const params: Record<string, string> = { queue, limit: String(batchSize) }
    if (ctx.db)
      params.db = ctx.db
    const url = buildUrl(ctx.base, params)
    void (async () => {
      try {
        while (!ctx.stopped() && !signal.aborted) {
          // Draining real jobs can run long, so the timeout is generous; it only
          // exists to unstick a stalled socket. Shutdown aborts via `signal`.
          const res = await fetchTick(url, { signal, timeoutMs: 60_000 })
          noteContact(res !== null)
          if (!res || res.error)
            break
          if (res.processed > 0) {
            sessionProcessed += res.processed
            rateWindow.push({ t: Date.now(), n: res.processed })
            if (!ctx.watch && !ctx.json)
              process.stdout.write(`${color.green('✓')} ${queue} ran ${res.processed}\n`)
          }
          if (res.processed === 0)
            break // drained — close the lane; the next snapshot reopens it on demand
        }
      }
      finally {
        inflight[queue] = Math.max(0, (inflight[queue] ?? 1) - 1)
      }
    })()
  }

  if (ctx.watch)
    process.stdout.write(CURSOR_HIDE)
  else if (!ctx.once && !ctx.json)
    process.stderr.write(`${color.dim(`cf-jobs work → ${ctx.host} (discovery from local D1; Ctrl-C to stop)`)}\n`)

  try {
    for (;;) {
      if (ctx.stopped())
        break

      const now = Date.now()
      // Keep the lease warm so the dev server defers draining to us.
      await refreshLease(now)

      // Demand discovery is a pure local read — the dev server isn't touched.
      let snapshot: QueueSnapshot[] = []
      let recent: RecentJob[] = []
      try {
        ({ snapshot, recent } = await readLocalSnapshot(localDb, sizing, ctx.recent))
      }
      catch (e) {
        if (!warnedSnapshot) {
          warnedSnapshot = true
          process.stderr.write(`${color.yellow('!')} could not read local D1 (migrations run yet?): ${(e as Error).message}\n`)
        }
      }

      // Fire drain lanes for queues with ready work — the one thing only the dev
      // server can do (run handlers in-process so live WebSockets see progress).
      for (const plan of planDrainLanes(snapshot, inflight, { onlyQueue: ctx.onlyQueue })) {
        for (let i = 0; i < plan.fire; i++)
          openLane(plan.queue, plan.batchSize)
      }

      while (rateWindow.length > 0 && now - rateWindow[0]!.t > 10_000)
        rateWindow.shift()
      const spanSec = Math.max(1, (now - (rateWindow[0]?.t ?? now)) / 1000)
      const ratePerSec = rateWindow.reduce((s, e) => s + e.n, 0) / spanSec

      if (ctx.watch) {
        const footer = serverDown
          ? color.yellow(`dev server unreachable at ${ctx.host} — draining paused, discovery live`)
          : color.dim('Ctrl-C to stop')
        repaint(`${renderWorkerDashboard({
          host: ctx.host,
          uptimeSeconds: Math.floor((now - startedAt) / 1000),
          nowSeconds: Math.floor(now / 1000),
          sessionProcessed,
          ratePerSec,
          inflight: { ...inflight },
          snapshot,
          recent,
        })}\n\n${footer}`)
      }
      else if (ctx.json) {
        process.stdout.write(`${JSON.stringify({ sessionProcessed, inflight, snapshot })}\n`)
      }

      const readySum = snapshot.reduce((n, q) => n + (ctx.onlyQueue && q.queue !== ctx.onlyQueue ? 0 : q.ready), 0)
      const lanes = Object.values(inflight).reduce((a, b) => a + b, 0)

      if (ctx.once) {
        // Can't drain ready work without the dev server — don't spin forever.
        if (serverDown && readySum > 0) {
          process.exitCode = 1
          break
        }
        if (readySum === 0 && lanes === 0)
          break
        await sleep(Math.min(ctx.interval, 150))
        continue
      }

      // The local read is demand discovery + dashboard refresh, not throughput
      // (lanes self-sustain off their own responses). So read at the base cadence
      // while there's anything happening, and back off toward ~3s when fully idle
      // — no busy-spinning an empty system. The watch dashboard keeps the base
      // cadence so uptime/relative-time stay live to the eye.
      const active = readySum > 0 || lanes > 0
      idle = active ? ctx.interval : Math.min(maxIdleInterval, idle * 2)
      await sleep(ctx.watch ? ctx.interval : idle)
    }
  }
  finally {
    localAbort.abort() // drop any in-flight lane/lease request so the process can exit
    close()
    if (ctx.watch)
      process.stdout.write(`${CURSOR_SHOW}\n`)
  }
}

interface WatchContext {
  /** App root — where `.wrangler` lives. */
  cwd: string
  /** Override local D1 sqlite file selection when multiple databases exist. */
  dbFile?: string
  interval: number
  onlyQueue?: string
  failuresOnly: boolean
  backfillSeconds: number
  stopped: () => boolean
}

/**
 * Read-only agent observer: emits one NDJSON line per terminal job (full,
 * untruncated error on failures) so an agent can watch the queues and fix issues
 * as they surface. Reads the local D1 SQLite directly — it never touches the dev
 * server (it neither drains nor holds the worker lease), so it works even while
 * the server is restarting and adds zero load to it.
 */
async function runWatch(ctx: WatchContext): Promise<void> {
  const { db: localDb, close } = openLocalD1(findLocalD1Sqlite(ctx.cwd, ctx.dbFile))
  const seen = new Set<string>()
  // Start from now minus the backfill window (default 0 -> only new events).
  let sinceSeconds = Math.max(0, Math.floor(Date.now() / 1000) - ctx.backfillSeconds)
  let warned = false

  try {
    for (;;) {
      if (ctx.stopped())
        break

      let recent: RecentJob[] = []
      try {
        recent = await recentTerminalJobs(localDb, { sinceSeconds, limit: 500 })
        warned = false
      }
      catch (e) {
        if (!warned) {
          warned = true
          process.stderr.write(`${color.yellow('!')} could not read local D1 (migrations run yet?): ${(e as Error).message}\n`)
        }
        await sleep(Math.max(ctx.interval, 1000))
        continue
      }

      if (ctx.onlyQueue)
        recent = recent.filter(j => j.queue === ctx.onlyQueue)
      if (ctx.failuresOnly)
        recent = recent.filter(j => j.outcome === 'failed')

      for (const job of selectNewTerminalJobs(recent, seen)) {
        seen.add(job.id)
        process.stdout.write(`${formatWatchEvent(job)}\n`)
        // Advance the cursor (1s overlap; dedup by id guards re-emit).
        sinceSeconds = Math.max(sinceSeconds, job.at - 1)
      }
      if (seen.size > 5000) {
        for (const id of seen) {
          seen.delete(id)
          if (seen.size <= 4000)
            break
        }
      }
      await sleep(ctx.interval)
    }
  }
  finally {
    close()
  }
}

/** Surface local-D1 setup failures (no `.wrangler` db yet, ambiguous file) as a clean line, not a stack trace. */
function reportSetupErrors(run: Promise<void>): Promise<void> {
  return run.catch((e: unknown) => {
    if (!(e instanceof LocalD1Error))
      throw e
    process.stderr.write(`${color.red('✖')} ${e.message}\n`)
    process.exitCode = 1
  })
}

function withSignals(run: (stopped: () => boolean, signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController()
  let stopped = false
  let hits = 0
  const stop = () => {
    stopped = true
    controller.abort() // unblock any in-flight fetch immediately
    // Second Ctrl-C is a hard escape hatch in case a loop is wedged outside an
    // abortable await — never leave the user mashing ^C with no effect.
    if (++hits >= 2)
      process.exit(130)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return run(() => stopped, controller.signal).finally(() => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  })
}

const work = defineCommand({
  meta: {
    name: 'work',
    description: 'Dev worker: drive a running `nuxt dev` server to drain durable jobs out-of-band so WebSockets observe live progress (nuxt dev only — NOT a production worker)',
  },
  args: {
    'url': { type: 'string', description: 'Dev server base URL (drain + lease target)', default: 'http://localhost:3000' },
    'interval': { type: 'string', description: 'Scheduler poll interval (ms)', default: '500' },
    'queue': { type: 'string', description: 'Only drain this logical queue' },
    'db': { type: 'string', description: 'Dev server\'s D1 binding name for draining (default: auto-detect)' },
    'db-file': { type: 'string', description: 'Local D1 sqlite file (relative to cwd) when multiple databases exist' },
    'once': { type: 'boolean', description: 'Drain everything ready now, then exit', default: false },
    'watch': { type: 'boolean', description: 'Live repainting dashboard (default on a TTY)', default: true },
    'recent': { type: 'string', description: 'Rows in the dashboard "recent" list', default: '12' },
    'json': { type: 'boolean', description: 'Emit one JSON line per interval (implies --no-watch)', default: false },
  },
  async run({ args }) {
    const base = args.url.replace(TRAILING_SLASH_RE, '')
    await reportSetupErrors(withSignals((stopped, signal) => runScheduler({
      base,
      host: hostOf(base),
      cwd: process.cwd(),
      dbFile: args['db-file'],
      interval: Math.max(50, Number(args.interval) || 500),
      onlyQueue: args.queue,
      db: args.db,
      recent: Math.max(1, Number(args.recent) || 12),
      once: args.once,
      json: args.json,
      watch: args.watch && !args.json && !args.once && process.stdout.isTTY === true,
      stopped,
      signal,
    })))
  },
})

const watch = defineCommand({
  meta: {
    name: 'watch',
    description: 'Stream durable job outcomes as NDJSON for agents (read-only; full exceptions on failures). Reads local D1 directly — never touches the dev server.',
  },
  args: {
    'interval': { type: 'string', description: 'Poll interval (ms)', default: '500' },
    'queue': { type: 'string', description: 'Only emit events for this logical queue' },
    'db-file': { type: 'string', description: 'Local D1 sqlite file (relative to cwd) when multiple databases exist' },
    'failures-only': { type: 'boolean', description: 'Only emit failed jobs (with full stack)', default: false },
    'backfill': { type: 'string', description: 'Replay terminal jobs from the last N seconds on start', default: '0' },
  },
  async run({ args }) {
    await reportSetupErrors(withSignals(stopped => runWatch({
      cwd: process.cwd(),
      dbFile: args['db-file'],
      interval: Math.max(50, Number(args.interval) || 500),
      onlyQueue: args.queue,
      failuresOnly: args['failures-only'],
      backfillSeconds: Math.max(0, Number(args.backfill) || 0),
      stopped,
    })))
  },
})

const main: CommandDef = defineCommand({
  meta: {
    name: 'cf-jobs',
    description: 'Inspect and manage nuxt-cf-jobs durable jobs in Cloudflare D1',
  },
  args: sharedArgs,
  subCommands: { status, jobs, failed, retry, forget, flush, clear, prune, migrate, schedule, tasks, work, watch },
  async run({ args, rawArgs }) {
    // No subcommand → default to the status overview.
    if (rawArgs.length === 0 || rawArgs.every(a => a.startsWith('-')))
      await runStatus(args as SharedArgs)
  },
})

export { main }

/** True only when this file is the process entry (the `cf-jobs` bin), not when imported (tests). */
function isCliEntry(): boolean {
  const invoked = process.argv[1]
  if (!invoked)
    return false
  try {
    // realpath both sides so the pnpm `.bin/cf-jobs` symlink resolves to the dist file.
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  }
  catch {
    return false
  }
}

if (isCliEntry()) {
  runMain(main).catch((error: unknown) => {
    const message = error instanceof D1ResolutionError || error instanceof Error ? error.message : String(error)
    process.stderr.write(`${color.red('✖')} ${message}\n`)
    process.exitCode = 1
  })
}
