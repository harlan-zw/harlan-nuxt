export type Evidence = Readonly<Record<string, unknown>>
export type CheckResult
  = | { _tag: 'Pass', evidence: Evidence }
    | { _tag: 'Warn' | 'Fail', reason: string, evidence: Evidence }
    | { _tag: 'Unavailable' | 'Skipped', reason: string }

export interface CheckContext<Event = unknown> {
  event: Event | undefined
  now: Date
  credentials: Readonly<Record<string, string>>
  signal: AbortSignal
}

export interface Check<Event = unknown> {
  id: string
  run: (context: CheckContext<Event>) => CheckResult | Promise<CheckResult>
}

export interface CheckRun {
  id: string
  durationMs: number
  result: CheckResult
}

export interface CheckReport {
  observedAt: string
  severity: 'pass' | 'warn' | 'fail'
  coverage: 'complete' | 'incomplete'
  results: CheckRun[]
}

export interface RunOptions<Event = unknown> {
  event?: Event
  now?: Date
  credentials?: Readonly<Record<string, string>>
  concurrency?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Receives exceptions outside the returned report. Do not publish raw errors to callers. */
  onError?: (error: unknown, id: string) => void
}

function reasonValue(reason: string): string {
  if (typeof reason !== 'string' || reason.trim() === '')
    throw new TypeError('Check reason must be a non-empty string.')
  return reason
}

export function pass(evidence: Evidence = {}): CheckResult {
  return { _tag: 'Pass', evidence }
}
export function warn(reason: string, evidence: Evidence = {}): CheckResult {
  return { _tag: 'Warn', reason: reasonValue(reason), evidence }
}
export function fail(reason: string, evidence: Evidence = {}): CheckResult {
  return { _tag: 'Fail', reason: reasonValue(reason), evidence }
}
export function unavailable(reason: string): CheckResult {
  return { _tag: 'Unavailable', reason: reasonValue(reason) }
}
export function skipped(reason: string): CheckResult {
  return { _tag: 'Skipped', reason: reasonValue(reason) }
}

export function defineCheck<Event = unknown>(check: Check<Event>): Check<Event> {
  if (!check || typeof check.id !== 'string' || !/^[\w.-]+$/.test(check.id))
    throw new TypeError('Check ID must contain letters, digits, underscores, dots, or hyphens.')
  if (typeof check.run !== 'function')
    throw new TypeError(`Check ${check.id} requires a run function.`)
  return check
}

export function defineChecks<Event = unknown>(checks: readonly Check<Event>[]): readonly Check<Event>[] {
  const ids = new Set<string>()
  for (const check of checks) {
    defineCheck(check)
    if (ids.has(check.id))
      throw new TypeError(`Duplicate check ID: ${check.id}`)
    ids.add(check.id)
  }
  return checks
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer.`)
  return value
}

function parseResult(value: unknown): CheckResult {
  if (!value || typeof value !== 'object' || !('_tag' in value))
    return unavailable('Check returned an invalid result.')
  const result = value as CheckResult
  if (result._tag === 'Unavailable' || result._tag === 'Skipped')
    return typeof result.reason === 'string' && result.reason.trim() ? result : unavailable('Check returned an invalid reason.')
  if (result._tag !== 'Pass' && result._tag !== 'Warn' && result._tag !== 'Fail')
    return unavailable('Check returned an invalid result.')
  if (result._tag !== 'Pass' && (typeof result.reason !== 'string' || !result.reason.trim()))
    return unavailable('Check returned an invalid reason.')
  if (!result.evidence || typeof result.evidence !== 'object' || Array.isArray(result.evidence))
    return unavailable('Check returned invalid evidence.')
  // Detach evidence before a timed-out producer can mutate a returned report.
  return JSON.parse(JSON.stringify(result, (_key, item: unknown) => {
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || (typeof item === 'number' && !Number.isFinite(item)))
      throw new TypeError('Check evidence must contain JSON values.')
    return item
  })) as CheckResult
}

async function runOne<Event>(check: Check<Event>, options: RunOptions<Event>, now: number, timeoutMs: number): Promise<CheckRun> {
  const start = performance.now()
  const controller = new AbortController()
  let resolveAbort: (result: CheckResult) => void = () => {}
  const aborted = new Promise<CheckResult>((resolve) => {
    resolveAbort = resolve
  })
  const cancel = () => {
    controller.abort()
    resolveAbort(unavailable('Check was cancelled.'))
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => {
    controller.abort()
    resolveAbort(unavailable('Check exceeded its deadline.'))
  }, timeoutMs)
  if (options.signal?.aborted)
    cancel()
  const execution = controller.signal.aborted
    ? aborted
    : Promise.resolve().then(() => check.run({ event: options.event, now: new Date(now), credentials: options.credentials ?? {}, signal: controller.signal })).then(parseResult).catch((error: unknown) => {
        options.onError?.(error, check.id)
        return unavailable('Check threw an exception.')
      })
  try {
    const result = await Promise.race([execution, aborted])
    return { id: check.id, durationMs: Math.max(0, performance.now() - start), result }
  }
  finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}

export async function runChecks<Event = unknown>(checks: readonly Check<Event>[], options: RunOptions<Event> = {}): Promise<CheckReport> {
  defineChecks(checks)
  const concurrency = positiveInteger(options.concurrency ?? 4, 'Check concurrency')
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, 'Check timeout')
  if (timeoutMs > 2_147_483_647)
    throw new TypeError('Check timeout exceeds the timer limit.')
  const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(now))
    throw new TypeError('Check observation time must be a valid date.')
  const results: CheckRun[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, checks.length) }, async () => {
    while (next < checks.length) {
      const index = next++
      results[index] = await runOne(checks[index]!, options, now, timeoutMs)
    }
  }))
  return {
    observedAt: new Date(now).toISOString(),
    severity: results.some(r => r.result._tag === 'Fail') ? 'fail' : results.some(r => r.result._tag === 'Warn') ? 'warn' : 'pass',
    coverage: results.length === 0 || results.some(r => r.result._tag === 'Unavailable') ? 'incomplete' : 'complete',
    results,
  }
}
