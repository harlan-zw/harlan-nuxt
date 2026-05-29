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
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
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
  retrySql,
  staleReservedSql,
  summarizeBackpressure,
} from './queries'
import { color, humanizeSeconds, nextCronRun, relativeTime, table, truncate } from './render'

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
  return /^y(?:es)?$/i.test(answer.trim())
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

const main: CommandDef = defineCommand({
  meta: {
    name: 'cf-jobs',
    description: 'Inspect and manage nuxt-cf-jobs durable jobs in Cloudflare D1',
  },
  args: sharedArgs,
  subCommands: { status, jobs, failed, retry, forget, flush, clear, migrate, schedule, tasks },
  async run({ args, rawArgs }) {
    // No subcommand → default to the status overview.
    if (rawArgs.length === 0 || rawArgs.every(a => a.startsWith('-')))
      await runStatus(args as SharedArgs)
  },
})

runMain(main).catch((error: unknown) => {
  const message = error instanceof D1ResolutionError || error instanceof Error ? error.message : String(error)
  process.stderr.write(`${color.red('✖')} ${message}\n`)
  process.exitCode = 1
})
