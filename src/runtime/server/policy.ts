import type { JobBackoff, JobDefinition } from './types'

export function resolveJobMaxAttempts(
  definition: Pick<JobDefinition<string, unknown, string, unknown, unknown, unknown>, 'tries' | 'maxAttempts'> | undefined,
): number | undefined {
  return definition?.tries ?? definition?.maxAttempts
}

export function resolveJobBackoff(backoff: JobBackoff | undefined, attempt: number): number | undefined {
  if (typeof backoff === 'function')
    return backoff(attempt)
  if (Array.isArray(backoff))
    return backoff[Math.min(Math.max(attempt - 1, 0), backoff.length - 1)]
  return backoff
}

export function resolveJobRetryDelay(
  definition: Pick<JobDefinition<string, unknown, string, unknown, unknown, unknown>, 'backoff'> | undefined,
  attempt: number,
  opts: { baseSeconds?: number, maxSeconds?: number } = {},
): number {
  const configured = resolveJobBackoff(definition?.backoff, attempt)
  if (configured !== undefined)
    return configured

  const base = opts.baseSeconds ?? 10
  const max = opts.maxSeconds ?? 300
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max)
}

export function createJobTraceId(prefix = 'job'): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export async function createJobUniqueKey(
  name: string,
  payload: unknown,
  uniqueId?: (payload: never) => string,
): Promise<string> {
  const source = uniqueId
    ? `${name}:${uniqueId(payload as never)}`
    : `${name}:${stableStringify(payload)}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return `job_unique_${toHex(digest)}`
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
