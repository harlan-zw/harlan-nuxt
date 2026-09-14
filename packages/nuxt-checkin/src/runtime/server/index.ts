export type Evidence = Readonly<Record<string, unknown>>
export type CheckResult
  = | { _tag: 'Pass', evidence: Evidence }
    | { _tag: 'Warn' | 'Fail', reason: string, evidence: Evidence, coverage?: 'incomplete' }
    | { _tag: 'Unavailable' | 'Skipped', reason: string }

export interface ReportIdentity {
  site: string
  environment: string
  deployment: string
}

export interface CollectionMetrics {
  requests?: number
  rowsRead?: number
  bytes?: number
}

export interface Collected<T> {
  value: T
  metrics?: CollectionMetrics
}

export interface CollectionRun extends CollectionMetrics {
  observedAt: string | null
  key: string
  durationMs: number
  outcome: 'complete' | 'incomplete'
}

export interface CheckContext<Event = unknown> {
  event: Event | undefined
  now: Date
  credentials: Readonly<Record<string, string>>
  signal: AbortSignal
  /** Share evidence within this run. Keys must not contain credentials or personal data. */
  collect: <T>(resource: object, key: string, load: (signal: AbortSignal) => Promise<Collected<T>>) => Promise<T>
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
  schemaVersion: 1
  identity: ReportIdentity | null
  collections: CollectionRun[]
  observedAt: string
  severity: 'pass' | 'warn' | 'fail'
  coverage: 'complete' | 'incomplete'
  results: CheckRun[]
}

export interface RunOptions<Event = unknown> {
  event?: Event
  identity?: ReportIdentity
  /** Expected IDs, maintained independently from discovered files. */
  required?: readonly string[]
  /** Whole-run deadline, including all collection. Defaults to 30 seconds. */
  totalTimeoutMs?: number
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
    return typeof result.reason === 'string' && result.reason.trim() ? { _tag: result._tag, reason: result.reason } : unavailable('Check returned an invalid reason.')
  if (result._tag !== 'Pass' && result._tag !== 'Warn' && result._tag !== 'Fail')
    return unavailable('Check returned an invalid result.')
  if (result._tag !== 'Pass' && (typeof result.reason !== 'string' || !result.reason.trim()))
    return unavailable('Check returned an invalid reason.')
  if (!result.evidence || typeof result.evidence !== 'object' || Array.isArray(result.evidence))
    return unavailable('Check returned invalid evidence.')
  if ('coverage' in value && (value._tag === 'Pass' || value.coverage !== 'incomplete'))
    return unavailable('Check returned invalid coverage.')
  // Detach evidence before a timed-out producer can mutate a returned report.
  const evidence = JSON.parse(JSON.stringify(result.evidence, (_key, item: unknown) => {
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || (typeof item === 'number' && !Number.isFinite(item)))
      throw new TypeError('Check evidence must contain JSON values.')
    return item
  })) as Evidence
  return result._tag === 'Pass' ? pass(evidence) : { _tag: result._tag, reason: result.reason, evidence, ...(result.coverage === 'incomplete' ? { coverage: 'incomplete' as const } : {}) }
}

interface RunState {
  signal: AbortSignal
  cancellationReason: () => string
  collect: CheckContext['collect']
}

async function runOne<Event>(check: Check<Event>, options: RunOptions<Event>, now: number, timeoutMs: number, state: RunState): Promise<CheckRun> {
  const start = performance.now()
  const controller = new AbortController()
  let resolveAbort: (result: CheckResult) => void = () => {}
  const aborted = new Promise<CheckResult>((resolve) => {
    resolveAbort = resolve
  })
  const cancel = () => {
    controller.abort()
    resolveAbort(unavailable(state.cancellationReason()))
  }
  state.signal.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => {
    controller.abort()
    resolveAbort(unavailable('Check exceeded its deadline.'))
  }, timeoutMs)
  if (state.signal.aborted)
    cancel()
  const execution = controller.signal.aborted
    ? aborted
    : Promise.resolve().then(() => check.run({ event: options.event, now: new Date(now), credentials: options.credentials ?? {}, signal: controller.signal, collect: state.collect })).then(parseResult).catch((error: unknown) => {
        options.onError?.(error, check.id)
        return unavailable('Check threw an exception.')
      })
  try {
    const result = await Promise.race([execution, aborted])
    return { id: check.id, durationMs: Math.max(0, performance.now() - start), result }
  }
  finally {
    clearTimeout(timeout)
    state.signal.removeEventListener('abort', cancel)
  }
}

function timerValue(value: number, name: string): number {
  positiveInteger(value, name)
  if (value > 2_147_483_647)
    throw new TypeError(`${name} exceeds the timer limit.`)
  return value
}

function collectionScope(signal: AbortSignal, now: number) {
  const runStarted = performance.now()
  const pending = new Map<CollectionRun, number>()
  const resources = new WeakMap<object, { values: Map<string, Promise<unknown>>, tail: Promise<unknown> }>()
  const records: CollectionRun[] = []
  const collect: CheckContext['collect'] = <T>(resource: object, key: string, load: (signal: AbortSignal) => Promise<Collected<T>>) => {
    if (signal.aborted)
      return Promise.reject(new Error('Run collection was cancelled.'))
    let entries = resources.get(resource)
    if (!entries) {
      entries = { values: new Map(), tail: Promise.resolve() }
      resources.set(resource, entries)
    }
    const existing = entries.values.get(key)
    if (existing)
      return existing as Promise<T>
    const started = performance.now()
    const record: CollectionRun = { key, observedAt: null, durationMs: 0, outcome: 'incomplete' }
    pending.set(record, started)
    records.push(record)
    const promise = entries.tail.then(() => {
      if (signal.aborted)
        throw new Error('Run collection was cancelled.')
      record.observedAt = new Date(now + performance.now() - runStarted).toISOString()
      return load(signal)
    }).then(({ value, metrics = {} }) => {
      for (const metric of Object.values(metrics)) {
        if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0)
          throw new TypeError('Collection metrics must be non-negative finite numbers.')
      }
      for (const key of ['requests', 'rowsRead', 'bytes'] as const) {
        if (metrics[key] !== undefined)
          record[key] = metrics[key]
      }
      record.outcome = 'complete'
      return value
    }).finally(() => {
      record.durationMs = performance.now() - started
      pending.delete(record)
    })
    entries.values.set(key, promise)
    // A failed collection is recorded and propagated to its consumers. It must not block unrelated reads.
    entries.tail = promise.then(() => undefined, () => undefined)
    return promise
  }
  return { collect, snapshot: () => records.map(record => ({ ...record, durationMs: pending.has(record) ? performance.now() - pending.get(record)! : record.durationMs })) }
}

export async function runChecks<Event = unknown>(checks: readonly Check<Event>[], options: RunOptions<Event> = {}): Promise<CheckReport> {
  defineChecks(checks)
  const required = [...new Set(options.required ?? [])]
  for (const id of required)
    defineCheck({ id, run: () => pass() })
  const identity = options.identity ? { ...options.identity } : null
  if (identity && [identity.site, identity.environment, identity.deployment].some(value => typeof value !== 'string' || !value.trim()))
    throw new TypeError('Report identity requires site, environment, and deployment.')
  const concurrency = positiveInteger(options.concurrency ?? 4, 'Check concurrency')
  const timeoutMs = timerValue(options.timeoutMs ?? 10_000, 'Check timeout')
  const totalTimeoutMs = timerValue(options.totalTimeoutMs ?? 30_000, 'Run timeout')
  const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(now))
    throw new TypeError('Check observation time must be a valid date.')
  const controller = new AbortController()
  let cancellationReason = 'Check was cancelled.'
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted)
    cancel()
  const timeout = setTimeout(() => {
    cancellationReason = 'Run exceeded its deadline.'
    controller.abort()
  }, totalTimeoutMs)
  const collection = collectionScope(controller.signal, now)
  const state: RunState = { signal: controller.signal, cancellationReason: () => cancellationReason, collect: collection.collect }
  const effectiveOptions = { ...options, credentials: Object.freeze({ ...options.credentials }) }
  const results: CheckRun[] = []
  let next = 0
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, checks.length) }, async () => {
      while (next < checks.length) {
        const index = next++
        results[index] = controller.signal.aborted
          ? { id: checks[index]!.id, durationMs: 0, result: unavailable(cancellationReason) }
          : await runOne(checks[index]!, effectiveOptions, now, timeoutMs, state)
      }
    }))
    const present = new Set(checks.map(check => check.id))
    for (const id of required) {
      if (!present.has(id))
        results.push({ id, durationMs: 0, result: unavailable('Required check is not registered.') })
    }
    return {
      schemaVersion: 1,
      identity,
      observedAt: new Date(now).toISOString(),
      severity: results.some(r => r.result._tag === 'Fail') ? 'fail' : results.some(r => r.result._tag === 'Warn') ? 'warn' : 'pass',
      coverage: results.length === 0 || results.some(r => isIncomplete(r.result)) ? 'incomplete' : 'complete',
      collections: collection.snapshot(),
      results,
    }
  }
  finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
    controller.abort()
  }
}

function isIncomplete(result: CheckResult): boolean {
  return result._tag === 'Unavailable' || ('coverage' in result && result.coverage === 'incomplete')
}

export interface ReportOptions {
  identity: ReportIdentity
  required: readonly string[]
  maxAgeMs: number
  now?: Date
}

/** Validate received reports against caller-owned expectations. No network or storage access. */
export function checkReport(input: unknown, options: ReportOptions): CheckResult {
  positiveInteger(options.maxAgeMs, 'Report maximum age')
  const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(now))
    throw new TypeError('Report observation time must be a valid date.')
  if (!input || typeof input !== 'object')
    return unavailable('Check report is missing.')
  const report = input as Record<string, unknown>
  if (report.schemaVersion !== 1 || !report.identity || typeof report.identity !== 'object' || !Array.isArray(report.results))
    return unavailable('Check report is invalid.')
  const identity = report.identity as Record<string, unknown>
  if (identity.site !== options.identity.site || identity.environment !== options.identity.environment || identity.deployment !== options.identity.deployment)
    return unavailable('Check report identity does not match.')
  const observedAt = typeof report.observedAt === 'string' ? Date.parse(report.observedAt) : NaN
  if (!Number.isFinite(observedAt) || observedAt > now)
    return unavailable('Check report observation time is invalid.')
  if (now - observedAt > options.maxAgeMs)
    return unavailable('Check report is stale.')
  const results: Array<{ id: string, result: CheckResult }> = []
  for (const entry of report.results) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[\w.-]+$/.test(entry.id) || results.some(r => r.id === entry.id))
      return unavailable('Check report contains invalid results.')
    try {
      results.push({ id: entry.id, result: parseResult(entry.result) })
    }
    catch {
      // The received report is untrusted JSON. Invalid evidence is an expected boundary failure.
      return unavailable('Check report contains invalid evidence.')
    }
  }
  const missing = options.required.filter(id => !results.some(result => result.id === id))
  const incomplete = missing.length > 0 || results.length === 0 || results.some(r => isIncomplete(r.result)) || report.coverage !== 'complete'
  const failures = results.filter(r => r.result._tag === 'Fail').map(r => r.id)
  const warnings = results.filter(r => r.result._tag === 'Warn').map(r => r.id)
  const evidence = { observedAt: report.observedAt, missing, failures, warnings, unavailable: results.filter(r => isIncomplete(r.result)).map(r => r.id) }
  if (failures.length || warnings.length) {
    return { _tag: failures.length ? 'Fail' : 'Warn', reason: failures.length ? 'Site checks failed.' : 'Site checks need attention.', evidence, ...(incomplete ? { coverage: 'incomplete' as const } : {}) }
  }
  return incomplete ? unavailable('Check report coverage is incomplete.') : pass(evidence)
}
