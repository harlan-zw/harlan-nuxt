import type { Entry, Fetcher, JevFailure, JevHttpClient, Questions, SystemOneResult } from '@harlan-zw/jev'
// The decision runner: the one path every jev judgement takes.
//
//   config -> journal reuse -> ask -> record
//
// Failures are values. `Unavailable` means the caller keeps today's behaviour;
// `Unconfigured` means no rows and today's behaviour. Reuse by digest happens
// before any network call. The journal is an injected adapter, so the runner
// stays pure: no drizzle, no nitro, no hidden singletons.
import type { JevResolvedConfig } from './config'
import { canonicalJson, createJevHttpClient, sha256Hex } from '@harlan-zw/jev'

export type JevDecision<Q extends Questions = Questions>
  = | { readonly _tag: 'Answer', readonly answers: SystemOneResult<Q>['answers'], readonly provenance: 'model' | 'reuse', readonly decisionId: string }
    | { readonly _tag: 'Unavailable', readonly message: string }
    | { readonly _tag: 'Unconfigured' }

export interface JevDecisionKey {
  seat: string
  subjectDigest: string
  questionVersion: string
}

/** A journaled decision row, as the schema factory stores it. */
export interface StoredDecision {
  id: string
  seat: string
  subjectDigest: string
  questionVersion: string
  stateDigest: string
  stateSnapshot: unknown
  answers: Record<string, unknown>
  provenance: 'model' | 'reuse'
  model: string
  siteId?: string | null
  subjectRef?: string | null
  latencyMs?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  createdAt?: Date | null
}

export type NewDecision = Omit<StoredDecision, 'id' | 'createdAt'> & { id?: string, createdAt?: Date }

/** The journal operations the runner needs; inject drizzle, D1, or memory. */
export interface JevJournal {
  find: (key: JevDecisionKey) => Promise<StoredDecision | undefined>
  insert: (row: NewDecision) => Promise<StoredDecision>
  isUniqueViolation: (error: unknown) => boolean
}

export function createInMemoryJevJournal(): JevJournal {
  const rows = new Map<string, StoredDecision>()
  const keyOf = (key: JevDecisionKey) => `${key.seat}\u0000${key.subjectDigest}\u0000${key.questionVersion}`
  return {
    async find(key) {
      const row = rows.get(keyOf(key))
      return row === undefined ? undefined : structuredClone(row)
    },
    async insert(row) {
      const key = keyOf(row)
      if (rows.has(key))
        throw new Error(`UNIQUE constraint failed: jev_decisions.seat, jev_decisions.subject_digest, jev_decisions.question_version for ${key}`)
      const stored = { ...row, id: row.id ?? crypto.randomUUID(), createdAt: row.createdAt ?? new Date() }
      rows.set(key, structuredClone(stored))
      return structuredClone(stored)
    },
    isUniqueViolation(error) {
      return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
    },
  }
}

export interface DecideJevOptions<Q extends Questions> {
  journal: JevJournal
  config: JevResolvedConfig
  seat: string
  questionVersion: string
  subject: string
  state: Entry
  questions: Q
  siteId?: string
  subjectRef?: string
  client?: JevHttpClient
  fetcher?: Fetcher
}

export async function decideJev<Q extends Questions>(options: DecideJevOptions<Q>): Promise<JevDecision<Q>> {
  if (!options.config.configured)
    return { _tag: 'Unconfigured' }

  const subjectDigest = await sha256Hex(canonicalJson({
    seat: options.seat,
    subject: options.subject,
    state: options.state,
    questionVersion: options.questionVersion,
  }))
  const key = { seat: options.seat, subjectDigest, questionVersion: options.questionVersion }

  const existing = await options.journal.find(key)
  if (existing !== undefined) {
    return { _tag: 'Answer', answers: existing.answers as SystemOneResult<Q>['answers'], provenance: 'reuse', decisionId: existing.id }
  }

  const client = options.client ?? createJevHttpClient({
    apiToken: options.config.apiToken,
    accountId: options.config.accountId,
    gatewayId: options.config.gatewayId,
    model: options.config.model,
    cacheTtl: options.config.cacheTtl,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  })

  const startedAt = Date.now()
  const call = await client.systemOne({ state: options.state, questions: options.questions })
  const latencyMs = Date.now() - startedAt
  if (call._tag === 'Err')
    return { _tag: 'Unavailable', message: `jev ${options.seat}: ${describeFailure(call.failure)}` }

  const result = call.result
  let row: StoredDecision
  try {
    row = await options.journal.insert({
      seat: options.seat,
      subjectDigest,
      questionVersion: options.questionVersion,
      stateDigest: await sha256Hex(canonicalJson(options.state)),
      stateSnapshot: options.state,
      answers: result.answers as Record<string, unknown>,
      provenance: 'model',
      model: result.model,
      ...(options.siteId === undefined ? {} : { siteId: options.siteId }),
      ...(options.subjectRef === undefined ? {} : { subjectRef: options.subjectRef }),
      latencyMs,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    })
  }
  catch (error: unknown) {
    if (!options.journal.isUniqueViolation(error))
      throw error
    const raced = await options.journal.find(key)
    if (raced === undefined)
      throw error
    return { _tag: 'Answer', answers: raced.answers as SystemOneResult<Q>['answers'], provenance: 'reuse', decisionId: raced.id }
  }
  return { _tag: 'Answer', answers: row.answers as SystemOneResult<Q>['answers'], provenance: 'model', decisionId: row.id }
}

function describeFailure(failure: JevFailure): string {
  if (failure._tag === 'Http')
    return `${failure.status} ${failure.message}${failure.requestId === undefined ? '' : ` (cf-ray ${failure.requestId})`}`
  return failure.message
}
