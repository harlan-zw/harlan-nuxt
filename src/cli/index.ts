#!/usr/bin/env node
/**
 * `cf-jobs` — a Laravel-`artisan`-style CLI for inspecting and managing the
 * durable D1 job tables this module writes. Read commands surface live
 * backpressure (queue depth, ready/reserved/delayed splits, ready-lag, failures)
 * straight from D1 via `wrangler d1 execute`; mutating commands mirror
 * `queue:retry` / `queue:forget` / `queue:flush` / `queue:clear`.
 */
import type { ArgsDef, CommandDef } from 'citty'
import type { ModuleOptions } from '../types'
import type { JobState } from './queries'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { defineCommand, runMain } from 'citty'
import { d1DurableJobMigrationSql } from '../runtime/server/d1'
import { collectTasks } from '../tasks'
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

export interface WorkerDashboardState {
  host: string
  uptimeSeconds: number
  /** Jobs the worker has driven this session. */
  sessionProcessed: number
  /** Rolling jobs/sec. */
  ratePerSec: number
  snapshot: Array<{ queue: string, ready: number, reserved: number, delayed: number, completed: number, failed: number }>
  recent: Array<{ id: string, type: string, queue: string, outcome: 'completed' | 'failed', durationMs: number | null, error: string | null }>
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
      ['QUEUE', 'READY', 'PROC', 'DONE', 'FAIL'],
      s.snapshot.map(q => [
        q.queue,
        q.ready > 0 ? color.yellow(q.ready) : '0',
        q.reserved > 0 ? color.cyan(q.reserved) : '0',
        q.completed,
        q.failed > 0 ? color.red(q.failed) : '0',
      ]),
      [false, true, true, true, true],
    ))
  }

  lines.push('')
  lines.push(color.dim('recent'))
  if (s.recent.length === 0) {
    lines.push(color.dim('  (nothing yet)'))
  }
  else {
    for (const j of s.recent) {
      const icon = j.outcome === 'completed' ? color.green('✓') : color.red('✗')
      const tail = j.outcome === 'completed'
        ? formatMs(j.durationMs)
        : color.red(truncate((j.error ?? '').split('\n')[0], 32))
      lines.push(`${icon} ${truncate(j.type, 24).padEnd(24)} ${color.dim(truncate(j.id, 12).padEnd(12))} ${tail}`)
    }
  }

  return lines.join('\n')
}

interface WorkTickResult {
  processed: number
  byQueue?: Record<string, number>
  remaining: number
  error?: string
  ambiguousBindings?: string[]
  snapshot?: WorkerDashboardState['snapshot']
  recent?: WorkerDashboardState['recent']
}

const TRAILING_SLASH_RE = /\/+$/
const CURSOR_HIDE = '[?25l'
const CURSOR_SHOW = '[?25h'
const CLEAR_FROM_HOME = '[H[0J'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchTick(endpoint: string): Promise<WorkTickResult | null> {
  return await fetch(endpoint, { method: 'POST' })
    .then(r => r.json() as Promise<WorkTickResult>)
    .catch((): WorkTickResult | null => null)
}

interface WorkLoopOptions {
  endpoint: string
  base: string
  interval: number
  stopped: () => boolean
}

/** Append-only line log: one `✓ ran N` per active tick. Used for --once, --json, or non-TTY. */
async function runLog(opts: WorkLoopOptions & { once: boolean, json: boolean }): Promise<void> {
  const { endpoint, base, interval, once, json, stopped } = opts
  const maxInterval = Math.max(interval, 5000)
  let warnedAmbiguous = false
  let idle = interval
  if (!once)
    process.stderr.write(`${color.dim(`cf-jobs work → ${endpoint} (Ctrl-C to stop)`)}\n`)

  for (;;) {
    if (stopped())
      break
    const tick = await fetchTick(endpoint)

    if (!tick || tick.error) {
      process.stderr.write(tick
        ? `${color.red('✖')} ${tick.error === 'no-d1-binding' ? 'no D1 binding found on the dev server env' : tick.error}\n`
        : `${color.yellow('…')} dev server unreachable at ${base}\n`)
      if (once) {
        process.exitCode = 1
        break
      }
      await sleep(maxInterval)
      continue
    }

    if (tick.ambiguousBindings && !warnedAmbiguous) {
      warnedAmbiguous = true
      process.stderr.write(`${color.yellow('!')} multiple D1 bindings (${tick.ambiguousBindings.join(', ')}); using the first. Pass --db to choose.\n`)
    }

    if (tick.processed > 0) {
      idle = interval
      if (json) {
        process.stdout.write(`${JSON.stringify(tick)}\n`)
      }
      else {
        const detail = tick.byQueue && Object.keys(tick.byQueue).length
          ? ` ${color.dim(`(${Object.entries(tick.byQueue).map(([q, n]) => `${q}:${n}`).join(', ')})`)}`
          : ''
        const waiting = tick.remaining > 0 ? color.dim(` — ${tick.remaining} waiting`) : ''
        process.stdout.write(`${color.green('✓')} ran ${tick.processed}${detail}${waiting}\n`)
      }
    }

    if (once) {
      if (tick.processed === 0 && tick.remaining === 0)
        break
      continue // drain as fast as the dev server allows
    }

    if (tick.processed === 0) {
      await sleep(idle)
      idle = Math.min(maxInterval, idle * 2)
    }
    else {
      await sleep(interval)
    }
  }
}

/** Live repainting dashboard: per-queue table + recent outcomes, refreshed every tick. */
async function runDashboard(opts: WorkLoopOptions): Promise<void> {
  const { endpoint, base, interval, stopped } = opts
  let host = base
  try {
    host = new URL(base).host
  }
  catch {}
  const startedAt = Date.now()
  let sessionProcessed = 0
  const rateWindow: Array<{ t: number, n: number }> = []
  const repaint = (frame: string) => process.stdout.write(`${CLEAR_FROM_HOME}${frame}`)

  process.stdout.write(CURSOR_HIDE)
  try {
    for (;;) {
      if (stopped())
        break
      const tick = await fetchTick(endpoint)
      const now = Date.now()

      if (!tick || tick.error) {
        repaint(`${tick ? `${color.red('✖')} ${tick.error === 'no-d1-binding' ? 'no D1 binding on the dev server env' : tick.error}` : `${color.yellow('…')} dev server unreachable at ${host}`}\n\n${color.dim('Ctrl-C to stop')}`)
        await sleep(interval)
        continue
      }

      sessionProcessed += tick.processed
      rateWindow.push({ t: now, n: tick.processed })
      while (rateWindow.length > 0 && now - rateWindow[0]!.t > 10_000)
        rateWindow.shift()
      const spanSec = Math.max(1, (now - (rateWindow[0]?.t ?? now)) / 1000)

      repaint(`${renderWorkerDashboard({
        host,
        uptimeSeconds: Math.floor((now - startedAt) / 1000),
        sessionProcessed,
        ratePerSec: rateWindow.reduce((s, e) => s + e.n, 0) / spanSec,
        snapshot: tick.snapshot ?? [],
        recent: tick.recent ?? [],
      })}\n\n${color.dim('Ctrl-C to stop')}`)
      await sleep(interval)
    }
  }
  finally {
    process.stdout.write(`${CURSOR_SHOW}\n`)
  }
}

const work = defineCommand({
  meta: {
    name: 'work',
    description: 'Dev worker: drive a running `nuxt dev` server to drain durable jobs out-of-band so WebSockets observe live progress (nuxt dev only — NOT a production worker)',
  },
  args: {
    url: { type: 'string', description: 'Dev server base URL', default: 'http://localhost:3000' },
    interval: { type: 'string', description: 'Poll interval (ms) when idle; backs off up to 5s', default: '500' },
    queue: { type: 'string', description: 'Only drain this logical queue' },
    limit: { type: 'string', description: 'Max jobs claimed per tick', default: '100' },
    db: { type: 'string', description: 'D1 binding name (default: auto-detect the only binding)' },
    once: { type: 'boolean', description: 'Drain everything ready now, then exit', default: false },
    watch: { type: 'boolean', description: 'Live repainting dashboard (default on a TTY)', default: true },
    recent: { type: 'string', description: 'Rows in the dashboard "recent" list', default: '12' },
    json: { type: 'boolean', description: 'Emit one JSON line per active tick (implies --no-watch)', default: false },
  },
  async run({ args }) {
    const base = args.url.replace(TRAILING_SLASH_RE, '')
    const params = new URLSearchParams({ limit: String(Number(args.limit) || 100) })
    if (args.queue)
      params.set('queue', args.queue)
    if (args.db)
      params.set('db', args.db)
    const interval = Math.max(50, Number(args.interval) || 500)
    const watch = args.watch && !args.json && !args.once && process.stdout.isTTY === true
    if (watch) {
      params.set('snapshot', '1')
      params.set('recent', String(Number(args.recent) || 12))
    }
    const endpoint = `${base}/__cf-jobs/work?${params}`

    let stopped = false
    const stop = () => {
      stopped = true
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    if (watch)
      await runDashboard({ endpoint, base, interval, stopped: () => stopped })
    else
      await runLog({ endpoint, base, interval, once: args.once, json: args.json, stopped: () => stopped })

    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  },
})

const main: CommandDef = defineCommand({
  meta: {
    name: 'cf-jobs',
    description: 'Inspect and manage nuxt-cf-jobs durable jobs in Cloudflare D1',
  },
  args: sharedArgs,
  subCommands: { status, jobs, failed, retry, forget, flush, clear, prune, migrate, schedule, tasks, work },
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
