import type { WranglerConfigInput } from '@harlan-zw/nuxt-cloudflare/wrangler'
import type { ModuleOptions, QueueBindingOptions } from './types'
import { readWranglerConfigFile } from '@harlan-zw/nuxt-cloudflare/wrangler'

export interface WranglerQueueProducer {
  binding: string
  queue: string
}

export interface WranglerQueueConsumer {
  queue: string
  maxBatchSize?: number
  maxBatchTimeout?: number
  maxRetries?: number
  maxConcurrency?: number
  retryDelay?: number
  deadLetterQueue?: string
}

export interface WranglerD1Database {
  binding: string
  /** `database_name` — the name passed to `wrangler d1 execute <name>`. */
  databaseName?: string
  databaseId?: string
}

export interface WranglerConfig {
  path: string
  producers: WranglerQueueProducer[]
  consumers: WranglerQueueConsumer[]
  /** `[triggers] crons = [...]` — undefined when the file declares no triggers block. */
  crons?: string[]
  /** `[[d1_databases]]` entries — the binding/name the CLI queries for job state. */
  d1Databases?: WranglerD1Database[]
}

const SNAKE_CASE_RE = /_([a-z])/g

function camelCase(key: string): string {
  return key.replace(SNAKE_CASE_RE, (_, c) => c.toUpperCase())
}

interface WranglerJsonConfig {
  queues?: { producers?: unknown[], consumers?: unknown[] }
  triggers?: { crons?: unknown }
  d1_databases?: unknown[]
}

function parseJsoncQueues(parsed: WranglerJsonConfig): { producers: WranglerQueueProducer[], consumers: WranglerQueueConsumer[] } {
  const queues = parsed.queues ?? {}
  const producers = Array.isArray(queues.producers) ? queues.producers : []
  const consumers = Array.isArray(queues.consumers) ? queues.consumers : []
  return {
    producers: producers
      .filter((p): p is { binding: string, queue: string } => !!p && typeof p === 'object' && typeof (p as { binding?: unknown }).binding === 'string' && typeof (p as { queue?: unknown }).queue === 'string')
      .map(p => ({ binding: p.binding, queue: p.queue })),
    consumers: consumers
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => {
        const out: WranglerQueueConsumer = { queue: String(c.queue ?? '') }
        for (const [k, v] of Object.entries(c)) {
          if (k === 'queue') {
            continue
          }
          ;(out as unknown as Record<string, unknown>)[camelCase(k)] = v
        }
        return out
      })
      .filter(c => c.queue.length > 0),
  }
}

function parseJsoncCrons(parsed: WranglerJsonConfig): string[] | undefined {
  const crons = parsed.triggers?.crons
  if (!Array.isArray(crons))
    return undefined
  return crons.filter((c): c is string => typeof c === 'string')
}

function parseJsoncD1Databases(parsed: WranglerJsonConfig): WranglerD1Database[] {
  const list = Array.isArray(parsed.d1_databases) ? parsed.d1_databases : []
  return list
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as { binding?: unknown }).binding === 'string')
    .map(d => ({
      binding: String(d.binding),
      databaseName: typeof d.database_name === 'string' ? d.database_name : undefined,
      databaseId: typeof d.database_id === 'string' ? d.database_id : undefined,
    }))
}

export function parseWranglerConfig(path: string): WranglerConfig {
  const loaded = readWranglerConfigFile(path)
  if (loaded._tag !== 'loaded') {
    const format = path.endsWith('.json') || path.endsWith('.jsonc') ? 'JSON ' : ''
    const reason = loaded._tag === 'missing' ? 'file does not exist' : loaded.reason
    throw new SyntaxError(`Invalid Wrangler ${format}config "${path}": ${reason}`)
  }
  const json = loaded.config as WranglerConfigInput & WranglerJsonConfig
  const parsed = parseJsoncQueues(json)
  const crons = parseJsoncCrons(json)
  const d1Databases = parseJsoncD1Databases(json)
  return { path, producers: parsed.producers, consumers: parsed.consumers, crons, d1Databases }
}

export interface CronCrossCheckResult {
  /** Crons a task needs that the wrangler file's `triggers.crons` is missing. */
  missing: string[]
  /** Crons declared in the wrangler file that no task uses (stale triggers). */
  extra: string[]
}

/**
 * Compare the derived cron union (from `defineScheduledTask`) against the crons
 * declared in an external wrangler config. `missing` is the drift that silently
 * stops scheduled tasks from firing on deploy.
 */
export function crossCheckCrons(wranglerCrons: readonly string[] | undefined, derived: readonly string[]): CronCrossCheckResult {
  if (!wranglerCrons)
    return { missing: [...derived], extra: [] }
  const have = new Set(wranglerCrons)
  const need = new Set(derived)
  return {
    missing: derived.filter(c => !have.has(c)),
    extra: wranglerCrons.filter(c => !need.has(c)),
  }
}

export function renderSuggestedCronsToml(crons: readonly string[]): string {
  return [
    '# Suggested wrangler.toml cron triggers for nuxt-cf-jobs scheduled tasks.',
    '# Generated; merge into your existing wrangler config.',
    '',
    '[triggers]',
    `crons = [${crons.map(c => `"${c}"`).join(', ')}]`,
    '',
  ].join('\n')
}

export interface WranglerCrossCheckIssue {
  reason: 'missing-producer' | 'missing-consumer' | 'producer-queue-mismatch' | 'max-retries-too-low'
  logical: string
  detail: string
}

export interface ModuleQueueExpectation {
  logical: string
  binding: string
  cfQueueName: string
  /**
   * When false, `cfQueueName` is just a fallback (derived from the logical key).
   * The cross-check will prefer the queue name from the producer entry that
   * matches `binding`, and won't flag a `producer-queue-mismatch`.
   */
  explicitQueueName?: boolean
  maxRetries?: number
  hasConsumer?: boolean
}

export function crossCheckWrangler(
  wrangler: WranglerConfig | undefined,
  expectations: readonly ModuleQueueExpectation[],
): WranglerCrossCheckIssue[] {
  if (!wrangler)
    return []

  const issues: WranglerCrossCheckIssue[] = []
  const producersByBinding = new Map(wrangler.producers.map(p => [p.binding, p]))
  const consumersByQueue = new Map(wrangler.consumers.map(c => [c.queue, c]))

  for (const exp of expectations) {
    const producer = producersByBinding.get(exp.binding)
    if (!producer) {
      issues.push({
        reason: 'missing-producer',
        logical: exp.logical,
        detail: `no [[queues.producers]] with binding="${exp.binding}" in ${wrangler.path}`,
      })
    }
    else if (exp.explicitQueueName && producer.queue !== exp.cfQueueName) {
      issues.push({
        reason: 'producer-queue-mismatch',
        logical: exp.logical,
        detail: `producer binding="${exp.binding}" points at queue="${producer.queue}" but module expects "${exp.cfQueueName}"`,
      })
    }

    if (exp.hasConsumer !== false) {
      const effectiveQueueName = producer && !exp.explicitQueueName ? producer.queue : exp.cfQueueName
      const consumer = consumersByQueue.get(effectiveQueueName)
      if (!consumer) {
        issues.push({
          reason: 'missing-consumer',
          logical: exp.logical,
          detail: `no [[queues.consumers]] for queue="${effectiveQueueName}" (handler is registered but wrangler won't deliver to it)`,
        })
      }
      else if (exp.maxRetries !== undefined && consumer.maxRetries !== undefined && consumer.maxRetries < exp.maxRetries - 1) {
        issues.push({
          reason: 'max-retries-too-low',
          logical: exp.logical,
          detail: `consumer max_retries=${consumer.maxRetries} is below tries=${exp.maxRetries} from job definitions (allows only ${consumer.maxRetries + 1} deliveries)`,
        })
      }
    }
  }

  return issues
}

export function renderSuggestedWranglerToml(expectations: readonly ModuleQueueExpectation[]): string {
  const lines: string[] = ['# Suggested wrangler.toml snippet for nuxt-cf-jobs queues.', '# Generated; merge into your existing wrangler config.', '']
  for (const exp of expectations) {
    lines.push('[[queues.producers]]')
    lines.push(`binding = "${exp.binding}"`)
    lines.push(`queue = "${exp.cfQueueName}"`)
    lines.push('')
  }
  for (const exp of expectations) {
    if (exp.hasConsumer === false)
      continue
    lines.push('[[queues.consumers]]')
    lines.push(`queue = "${exp.cfQueueName}"`)
    if (exp.maxRetries !== undefined)
      lines.push(`max_retries = ${exp.maxRetries}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Derive the per-queue expectations the cross-check works against from the
 * module's `queues` map. A string value is the binding name; an object may pin
 * an explicit `queueName` (otherwise the logical key is the fallback).
 */
export function buildQueueExpectations(queues: ModuleOptions['queues'] | undefined): ModuleQueueExpectation[] {
  const expectations: ModuleQueueExpectation[] = []
  for (const [logical, config] of Object.entries(queues ?? {})) {
    const binding = typeof config === 'string' ? config : config?.binding
    if (!binding)
      continue
    const explicitQueueName = typeof config === 'object' && !!config?.queueName
    const cfQueueName = explicitQueueName ? (config as { queueName: string }).queueName : logical
    expectations.push({ logical, binding, cfQueueName, explicitQueueName })
  }
  return expectations
}

/**
 * Read `[[queues.producers]]` / `[[queues.consumers]]` declared inline via
 * `nitro.cloudflare.wrangler` (or `nitro.cloudflare.deploy.configuration`),
 * normalizing snake_case consumer keys to the camelCase `WranglerQueueConsumer`
 * shape. Returns undefined when nitro declares no queues.
 */
export function normalizeNitroQueues(nitroOptions: unknown): { producers: WranglerQueueProducer[], consumers: WranglerQueueConsumer[] } | undefined {
  const cf = (nitroOptions as { cloudflare?: { wrangler?: { queues?: { producers?: unknown[], consumers?: unknown[] } }, deploy?: { configuration?: { queues?: { producers?: unknown[], consumers?: unknown[] } } } } })?.cloudflare
  const queues = cf?.wrangler?.queues ?? cf?.deploy?.configuration?.queues
  if (!queues)
    return undefined
  const producers: WranglerQueueProducer[] = []
  const consumers: WranglerQueueConsumer[] = []
  for (const p of queues.producers ?? []) {
    if (!p || typeof p !== 'object')
      continue
    const obj = p as { binding?: unknown, queue?: unknown }
    if (typeof obj.binding === 'string' && typeof obj.queue === 'string')
      producers.push({ binding: obj.binding, queue: obj.queue })
  }
  for (const c of queues.consumers ?? []) {
    if (!c || typeof c !== 'object')
      continue
    const obj = c as Record<string, unknown>
    if (typeof obj.queue !== 'string')
      continue
    const consumer: WranglerQueueConsumer = { queue: obj.queue }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'queue') {
        continue
      }
      ;(consumer as unknown as Record<string, unknown>)[camelCase(k)] = v
    }
    consumers.push(consumer)
  }
  return { producers, consumers }
}

/**
 * Merge file-parsed wrangler queues with nitro-config queues into one view.
 * Producers dedupe on `binding::queue`, consumers on `queue`; nitro entries win
 * on collision. Returns undefined when neither source declares anything.
 */
export function mergeWranglerSources(
  fileWrangler: WranglerConfig | undefined,
  nitroQueues: { producers: WranglerQueueProducer[], consumers: WranglerQueueConsumer[] } | undefined,
  fallbackPath: string,
): WranglerConfig | undefined {
  if (!fileWrangler && !nitroQueues)
    return undefined
  const producerKey = (p: WranglerQueueProducer) => `${p.binding}::${p.queue}`
  const consumerKey = (c: WranglerQueueConsumer) => c.queue
  const producers = new Map<string, WranglerQueueProducer>()
  const consumers = new Map<string, WranglerQueueConsumer>()
  for (const p of fileWrangler?.producers ?? [])
    producers.set(producerKey(p), p)
  for (const c of fileWrangler?.consumers ?? [])
    consumers.set(consumerKey(c), c)
  for (const p of nitroQueues?.producers ?? [])
    producers.set(producerKey(p), p)
  for (const c of nitroQueues?.consumers ?? [])
    consumers.set(consumerKey(c), c)
  return {
    path: fileWrangler?.path ?? `${fallbackPath} (nitro.cloudflare.deploy.configuration)`,
    producers: [...producers.values()],
    consumers: [...consumers.values()],
  }
}

export interface ReconcileQueuesInput {
  /** The module's `cfJobs.queues` map. */
  queues: ModuleOptions['queues'] | undefined
  /** Parsed external wrangler config, if one was found. */
  fileWrangler?: WranglerConfig
  /** Raw `nuxt.options.nitro` — inline queue declarations are read from it. */
  nitroOptions?: unknown
  /** Path shown in the merged config when only nitro-config queues exist. */
  fallbackPath: string
}

export interface ReconcileQueuesResult {
  /** Expectations derived from the module `queues` map. Empty → nothing to check. */
  expectations: ModuleQueueExpectation[]
  /** Suggested `[[queues.*]]` TOML the user can diff against their config. */
  suggestedToml: string
  /** File + nitro-config queues merged into one view, or undefined when neither exists. */
  merged: WranglerConfig | undefined
  /** Drift between `merged` and `expectations`. Empty when aligned (or no merged source). */
  issues: WranglerCrossCheckIssue[]
}

/**
 * Pure build-time reconciliation of declared `queues` against the wrangler file
 * + `nitro.cloudflare` queues. Returns everything `module.ts` needs to emit the
 * suggested-TOML template and log drift, with no Nuxt or IO dependency so the
 * merge/normalize/cross-check logic is unit testable on plain objects.
 */
/**
 * Fill each queue's `maxConcurrency` / `maxBatchSize` from its wrangler
 * `[[queues.consumers]]` entry when the module option leaves them unset. This is
 * what lets the dev worker (`cf-jobs work`) fan out at the SAME per-queue
 * concurrency the production consumer uses, without duplicating the numbers into
 * `cfJobs.queues`. A value declared on the module option always wins; queues with
 * no matching consumer (or no concurrency on it) pass through unchanged.
 */
export function enrichQueuesWithConsumerConfig(
  queues: ModuleOptions['queues'],
  expectations: readonly ModuleQueueExpectation[],
  consumers: readonly WranglerQueueConsumer[],
): ModuleOptions['queues'] {
  const cfNameByLogical = new Map(expectations.map(e => [e.logical, e.cfQueueName]))
  const consumerByQueue = new Map(consumers.map(c => [c.queue, c]))
  const out: Record<string, string | QueueBindingOptions> = {}
  for (const [logical, config] of Object.entries(queues)) {
    const consumer = consumerByQueue.get(cfNameByLogical.get(logical) ?? logical)
    if (!consumer || (consumer.maxConcurrency === undefined && consumer.maxBatchSize === undefined)) {
      out[logical] = config
      continue
    }
    const opts: QueueBindingOptions = typeof config === 'string' ? { binding: config } : { ...config }
    opts.maxConcurrency ??= consumer.maxConcurrency
    opts.maxBatchSize ??= consumer.maxBatchSize
    out[logical] = opts
  }
  return out
}

export function reconcileQueues(input: ReconcileQueuesInput): ReconcileQueuesResult {
  const expectations = buildQueueExpectations(input.queues)
  const suggestedToml = renderSuggestedWranglerToml(expectations)
  const merged = mergeWranglerSources(
    input.fileWrangler,
    normalizeNitroQueues(input.nitroOptions),
    input.fallbackPath,
  )
  const issues = crossCheckWrangler(merged, expectations)
  return { expectations, suggestedToml, merged, issues }
}
