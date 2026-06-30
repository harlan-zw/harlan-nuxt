import type { D1DatabaseLike } from './d1'

const SQL_IDENTIFIER_RE = /^[a-z_]\w*$/i

export type DurableJobStatus = 'queued' | 'scheduled' | 'running' | 'completed' | 'failed'

export interface DurableJobStatusInput {
  failed_at?: number | null
  failedAt?: number | null
  completed_at?: number | null
  completedAt?: number | null
  reserved_at?: number | null
  reservedAt?: number | null
  available_at?: number | null
  availableAt?: number | null
}

export type DurableBatchMemberState = 'pending' | 'running' | 'done' | 'failed'

export interface DurableBatchMember {
  id: string
  jobType: string
  state: DurableBatchMemberState
}

export interface ListD1BatchMembersOptions {
  jobsTable?: string
  failedJobsTable?: string
}

interface ActiveBatchMemberRow {
  id: string
  jobType: string
  reservedAt: number | null
  completedAt: number | null
}

interface FailedBatchMemberRow {
  id: string
  jobType: string
}

export function getDurableJobStatus(
  job: DurableJobStatusInput,
  now = Math.floor(Date.now() / 1000),
): DurableJobStatus {
  if (hasTimestamp(job, 'failed_at', 'failedAt'))
    return 'failed'
  if (hasTimestamp(job, 'completed_at', 'completedAt'))
    return 'completed'
  if (hasTimestamp(job, 'reserved_at', 'reservedAt'))
    return 'running'
  if ((timestamp(job, 'available_at', 'availableAt') ?? 0) > now)
    return 'scheduled'
  return 'queued'
}

export function resolveDurableBatchMemberState(
  job: Pick<DurableJobStatusInput, 'completed_at' | 'completedAt' | 'reserved_at' | 'reservedAt'>,
): DurableBatchMemberState {
  if (hasTimestamp(job, 'completed_at', 'completedAt'))
    return 'done'
  if (hasTimestamp(job, 'reserved_at', 'reservedAt'))
    return 'running'
  return 'pending'
}

export async function listD1BatchMembers(
  db: D1DatabaseLike,
  batchId: string,
  opts: ListD1BatchMembersOptions = {},
): Promise<DurableBatchMember[]> {
  const jobsTable = sqlIdentifier(opts.jobsTable ?? 'jobs')
  const failedJobsTable = sqlIdentifier(opts.failedJobsTable ?? 'failed_jobs')

  const active = await all<ActiveBatchMemberRow>(db, `
    SELECT
      id,
      job_type AS jobType,
      reserved_at AS reservedAt,
      completed_at AS completedAt
    FROM ${jobsTable}
    WHERE batch_id = ?
    ORDER BY
      CASE
        WHEN reserved_at IS NOT NULL THEN 0
        WHEN completed_at IS NOT NULL THEN 1
        ELSE 2
      END ASC,
      COALESCE(reserved_at, completed_at, created_at, 0) DESC,
      id ASC
  `, [batchId])
  const failed = await all<FailedBatchMemberRow>(db, `
    SELECT
      id,
      job_type AS jobType
    FROM ${failedJobsTable}
    WHERE batch_id = ?
    ORDER BY failed_at DESC, id ASC
  `, [batchId])

  const seen = new Set<string>()
  const members = active.map((row) => {
    seen.add(row.id)
    return {
      id: row.id,
      jobType: row.jobType,
      state: resolveDurableBatchMemberState(row),
    }
  })

  for (const row of failed) {
    if (seen.has(row.id))
      continue
    members.push({ id: row.id, jobType: row.jobType, state: 'failed' })
  }

  return members
}

async function all<T>(db: D1DatabaseLike, query: string, bindings: unknown[]): Promise<T[]> {
  const statement = db.prepare<T>(query).bind(...bindings)
  if (typeof statement.all !== 'function')
    throw new Error('D1 all() support is required to list durable batch members')
  const result = await statement.all<T>()
  return result.results ?? []
}

function timestamp(
  input: DurableJobStatusInput,
  snake: keyof DurableJobStatusInput,
  camel: keyof DurableJobStatusInput,
): number | null | undefined {
  return input[snake] ?? input[camel]
}

function hasTimestamp(
  input: DurableJobStatusInput,
  snake: keyof DurableJobStatusInput,
  camel: keyof DurableJobStatusInput,
): boolean {
  return timestamp(input, snake, camel) != null
}

function sqlIdentifier(value: string): string {
  if (!SQL_IDENTIFIER_RE.test(value))
    throw new Error(`Invalid SQL identifier: ${value}`)
  return value
}
