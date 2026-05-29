import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']

export function findWranglerConfig(rootDir: string): string | undefined {
  for (const name of WRANGLER_FILES) {
    const full = resolve(rootDir, name)
    if (existsSync(full))
      return full
  }
  return undefined
}

function stripJsoncComments(source: string): string {
  // remove /* ... */ blocks and // line comments outside strings (best-effort)
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, (_match, prefix) => prefix)
}

function camelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function parseTomlQueueBlocks(source: string): { producers: WranglerQueueProducer[], consumers: WranglerQueueConsumer[] } {
  const producers: WranglerQueueProducer[] = []
  const consumers: WranglerQueueConsumer[] = []
  const blockRe = /^\s*\[\[\s*queues\.(producers|consumers)\s*\]\]\s*$/gm
  const matches: Array<{ kind: 'producers' | 'consumers', index: number }> = []
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(source)) !== null)
    matches.push({ kind: m[1] as 'producers' | 'consumers', index: m.index + m[0].length })

  const stopRe = /^\s*\[[^\]]+\]\]?\s*$/m
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index
    const end = i + 1 < matches.length ? matches[i + 1]!.index - (matches[i + 1]?.kind.length ?? 0) : source.length
    const slice = source.slice(start, end)
    const nextHeader = stopRe.exec(slice)
    const body = nextHeader ? slice.slice(0, nextHeader.index) : slice
    const entry: Record<string, string | number> = {}
    for (const line of body.split('\n')) {
      const kv = line.match(/^\s*([a-z_]+)\s*=\s*(.+?)\s*(?:#.*)?$/i)
      if (!kv)
        continue
      const key = camelCase(kv[1]!)
      const raw = kv[2]!.trim()
      if (raw.startsWith('"') || raw.startsWith('\''))
        entry[key] = raw.slice(1, -1)
      else if (/^-?\d+(?:\.\d+)?$/.test(raw))
        entry[key] = Number(raw)
      else
        entry[key] = raw
    }
    if (matches[i]!.kind === 'producers' && typeof entry.binding === 'string' && typeof entry.queue === 'string')
      producers.push({ binding: entry.binding, queue: entry.queue })
    if (matches[i]!.kind === 'consumers' && typeof entry.queue === 'string') {
      const consumer: WranglerQueueConsumer = { queue: entry.queue }
      for (const [k, v] of Object.entries(entry)) {
        if (k === 'queue') {
          continue
        }(consumer as unknown as Record<string, unknown>)[k] = v
      }
      consumers.push(consumer)
    }
  }

  return { producers, consumers }
}

function parseJsoncQueues(source: string): { producers: WranglerQueueProducer[], consumers: WranglerQueueConsumer[] } {
  const stripped = stripJsoncComments(source)
  let parsed: { queues?: { producers?: unknown[], consumers?: unknown[] } } = {}
  try { parsed = JSON.parse(stripped) }
  catch { return { producers: [], consumers: [] } }
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
          }(out as unknown as Record<string, unknown>)[camelCase(k)] = v
        }
        return out
      })
      .filter(c => c.queue.length > 0),
  }
}

const ARRAY_STRING_RE = /(['"])(.*?)\1/g

function parseStringArrayLiteral(raw: string): string[] {
  return [...raw.matchAll(ARRAY_STRING_RE)].map(m => m[2]!)
}

function parseTomlCrons(source: string): string[] | undefined {
  // `[triggers]` table with `crons = ["...", "..."]` (may span lines).
  const header = /^\s*\[triggers\]\s*$/m.exec(source)
  if (!header)
    return undefined
  const rest = source.slice(header.index + header[0].length)
  // Stop at the next table header.
  const next = /^\s*\[/m.exec(rest)
  const body = next ? rest.slice(0, next.index) : rest
  const cronsMatch = body.match(/crons\s*=\s*\[([\s\S]*?)\]/)
  if (!cronsMatch)
    return undefined
  return parseStringArrayLiteral(cronsMatch[1]!)
}

function parseJsoncCrons(source: string): string[] | undefined {
  const stripped = stripJsoncComments(source)
  let parsed: { triggers?: { crons?: unknown } } = {}
  try {
    parsed = JSON.parse(stripped)
  }
  catch {
    return undefined
  }
  const crons = parsed.triggers?.crons
  if (!Array.isArray(crons))
    return undefined
  return crons.filter((c): c is string => typeof c === 'string')
}

// `[ \t]` rather than `\s` keeps these linear (no unicode-whitespace backtracking).
const D1_BLOCK_RE = /^[ \t]*\[\[[ \t]*d1_databases[ \t]*\]\][ \t]*$/gm
const TOML_TABLE_HEADER_RE = /^[ \t]*\[/m
// key = "value"  (quoted string only; trailing comments after the close quote are ignored)
const TOML_STRING_KV_RE = /^([a-z_]+)[ \t]*=[ \t]*(["'])(.*?)\2/i

function parseTomlD1Databases(source: string): WranglerD1Database[] {
  const out: WranglerD1Database[] = []
  for (const block of source.matchAll(D1_BLOCK_RE)) {
    const slice = source.slice(block.index + block[0].length)
    const next = TOML_TABLE_HEADER_RE.exec(slice)
    const body = next ? slice.slice(0, next.index) : slice
    const entry: Record<string, string> = {}
    for (const line of body.split('\n')) {
      const kv = line.trim().match(TOML_STRING_KV_RE)
      if (kv)
        entry[camelCase(kv[1]!)] = kv[3]!
    }
    if (entry.binding)
      out.push({ binding: entry.binding, databaseName: entry.databaseName, databaseId: entry.databaseId })
  }
  return out
}

function parseJsoncD1Databases(source: string): WranglerD1Database[] {
  let parsed: { d1_databases?: unknown[] } = {}
  try {
    parsed = JSON.parse(stripJsoncComments(source))
  }
  catch {
    return []
  }
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
  const source = readFileSync(path, 'utf8')
  const isJson = path.endsWith('.jsonc') || path.endsWith('.json')
  const parsed = isJson ? parseJsoncQueues(source) : parseTomlQueueBlocks(source)
  const crons = isJson ? parseJsoncCrons(source) : parseTomlCrons(source)
  const d1Databases = isJson ? parseJsoncD1Databases(source) : parseTomlD1Databases(source)
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
