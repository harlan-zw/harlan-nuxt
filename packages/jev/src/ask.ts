// `ask(state, questions)`: tagged-template sugar over the tagged-failure Jev
// client. Ported from pithings/advocaat (MIT).
//
// Failure style: the core client never throws; failures are tagged values.
// ask keeps that contract. Every ask path resolves: batches resolve to
// `{ _tag: 'Ok', answers }` or `{ _tag: 'Err', failure }`, and awaiting a
// tag on its own resolves to its answer or the same tagged failure. Nothing
// rejects, so one pattern covers both APIs.

import type { JevFailure, JevHttpClientOptions } from './client'
import type { ChoiceAnswer, ChoiceCriteria, ChoiceQuestion, Entry, Json, NoulQuestion, Question, ScoreAnswer, ScoreCriteria, ScoreQuestion } from './questions'
import { createJevHttpClient } from './client'
import { choice as choiceQuestion, noul, score as scoreQuestion } from './questions'

/** A bare string is a yes/no question. */
export type AskQuestion = string | Question | IfQuestion

export interface AskQuestions { [name: string]: AskQuestion }

export interface ChanceAnswer {
  readonly type: 'chance'
  /** Probability of a yes answer, from zero to one. */
  readonly chance: number
}

/** One ask failure: the same tagged value the core client returns. */
export interface AskFailure {
  readonly _tag: 'Err'
  readonly failure: JevFailure
}

export type Answer<Q extends AskQuestion> = Q extends IfQuestion
  ? boolean
  : Q extends string | NoulQuestion
    ? ChanceAnswer
    : Q extends ScoreQuestion<infer S>
      ? ScoreAnswer<S> & { /** Score scaled to 0 to 1. */ readonly ratio: number }
      : Q extends ChoiceQuestion<infer C>
        ? ChoiceAnswer<C>
        : never

export type Answers<Q extends AskQuestions> = { readonly [K in keyof Q]: Answer<Q[K]> }

/** Client options with credentials optional; the environment fills them. */
export type AskOptions = Omit<JevHttpClientOptions, 'apiToken' | 'accountId'> & {
  /** Env: `CLOUDFLARE_ACCOUNT_ID`. */
  accountId?: string
  /** Env: `CLOUDFLARE_API_TOKEN`. Needs `Account > Workers AI > Read`. */
  apiToken?: string
}

/** One batch: answers under the same keys, or one tagged failure. */
export type AskResult<Q extends AskQuestions = AskQuestions>
  = | { readonly _tag: 'Ok', readonly answers: Answers<Q> }
    | AskFailure

/** One tag awaited on its own: its answer, or one tagged failure. */
export type AskAnswer<Q extends Question | IfQuestion> = Answer<Q> | AskFailure

/** A question from a tag: a key in `ask`, or awaited on its own to send it with its interpolated state. */
export type Askable<Q extends Question | IfQuestion> = Q & PromiseLike<AskAnswer<Q>>

/** A yes/no question from `ask.if` that resolves to a boolean. */
export interface IfQuestion {
  readonly type: 'if'
  readonly instructions: string
  readonly threshold: number
}

// Interpolated objects of tagged questions, kept off the wire until sent.
const states = new WeakMap<object, Parsed>()

/** Sends every question in one request and resolves to answers under the same keys, or one tagged failure. */
export async function ask<const Q extends AskQuestions>(
  state: Entry,
  questions: Q,
  options: AskOptions = {},
): Promise<AskResult<Q>> {
  const wire: { [name: string]: Question } = {}
  const tagged: [string, Parsed][] = []
  for (const [name, q] of Object.entries(questions)) {
    if (typeof q === 'string') {
      wire[name] = noul(q)
      continue
    }
    const own = states.get(q)
    if (own !== undefined)
      tagged.push([name, own])
    wire[name] = q.type === 'if' ? noul(q.instructions) : q
  }
  // Interpolated objects of all tags go once each into `input`, and their slots become its paths.
  // A text or array state goes first among them.
  const inputs: Json[] = [...new Set(tagged.flatMap(([, own]) => own.parts))]
  let merged = state
  if (inputs.length > 0) {
    if (merged === null || typeof merged !== 'object' || Array.isArray(merged)) {
      if (merged !== '' && merged !== null && !inputs.includes(merged))
        inputs.unshift(merged)
      merged = {}
    }
    if (Object.hasOwn(merged, 'input'))
      return invalid('state already has "input"')
    merged = { ...merged, input: inputs.length > 1 ? inputs : inputs[0]! }
    const path = paths(inputs)
    for (const [name, own] of tagged)
      wire[name] = { ...wire[name]!, instructions: own.render(path) }
  }
  const failure = missingCredentials(options)
  if (failure !== null)
    return failure
  const call = await createJevHttpClient({
    ...options,
    apiToken: options.apiToken ?? env('CLOUDFLARE_API_TOKEN')!,
    accountId: options.accountId ?? env('CLOUDFLARE_ACCOUNT_ID')!,
    gatewayId: options.gatewayId ?? env('CLOUDFLARE_AI_GATEWAY_ID'),
  }).systemOne({ state: merged, questions: wire })
  if (call._tag === 'Err')
    return { _tag: 'Err', failure: call.failure }
  const out: { [name: string]: unknown } = {}
  // Iterate the requested questions, not the returned answers: an answer name
  // we never asked about (or a missing one) must never crash the mapping.
  for (const [name, q] of Object.entries(questions)) {
    const a = (call.result.answers as Record<string, { type?: string } | undefined>)[name]
    if (a === undefined || typeof a.type !== 'string')
      continue
    out[name]
      = a.type === 'noul'
        ? typeof q === 'object' && q.type === 'if'
          ? (a as { noul: number }).noul > q.threshold
          : { type: 'chance', chance: (a as { noul: number }).noul }
        : a.type === 'score'
          ? { ...a, ratio: (a as { score: number }).score / ((wire[name] as ScoreQuestion).criteria.length - 1) }
          : a
  }
  return { _tag: 'Ok', answers: out as Answers<Q> }
}

type Strings = TemplateStringsArray

const isTag = (first: unknown): first is Strings => Array.isArray(first) && 'raw' in first

/** An interpolated object or array. */
type Part = Json[] | { [key: string]: Json }

interface Parsed {
  /** Instructions as sent on its own: paths over its own parts only. */
  instructions: string
  /** Distinct interpolated objects, in order of first use. */
  parts: Part[]
  render: (path: (part: Part) => string) => string
}

// Path of a part sent under `input`: the whole of it when it is the only one.
function paths(inputs: Json[]) {
  return (part: Part) =>
    inputs.length > 1 ? `\`input[${inputs.indexOf(part)}]\`` : '`input`'
}

// Text values go into the question; objects and arrays are sent in the state and their slots become paths.
function parse(strings: Strings, values: unknown[]): Parsed {
  const slots = values.map(value =>
    typeof value === 'object' && value !== null ? (value as Part) : String(value),
  )
  const parts = [...new Set(slots.filter((slot): slot is Part => typeof slot !== 'string'))]
  const render: Parsed['render'] = path =>
    strings.reduce((out, s, i) => {
      const slot = slots[i - 1]!
      return out + (typeof slot === 'string' ? slot : path(slot)) + s
    })
  return { instructions: render(paths(parts)), parts, render }
}

// Adds a hidden `then` that sends the question alone under `input`, so the object stays a plain question.
function askable<Q extends Question | IfQuestion>(q: Q, parsed?: Parsed, options?: AskOptions) {
  if (parsed?.parts.length)
    states.set(q, parsed)
  const then: PromiseLike<AskAnswer<Q>>['then'] = (ok, fail) =>
    ask('', { input: q }, options)
      .then(result => (result._tag === 'Ok' ? result.answers.input : result))
      .then(ok, fail)
  return Object.defineProperty(q, 'then', { value: then }) as Askable<Q>
}

// Each tag works both as ask.choice`...`(criteria, options?) and ask.choice(instructions, criteria, options?),
// where plain-call instructions may be a JSON object or array.
function tag<C, Q extends Question>(build: (instructions: Entry, criteria: C) => Q) {
  return (first: Entry | Strings, ...rest: unknown[]) => {
    if (!isTag(first))
      return askable(build(first, rest[0] as C), undefined, rest[1] as AskOptions)
    const parsed = parse(first, rest)
    return (criteria: C, options?: AskOptions) =>
      askable(build(parsed.instructions, criteria), parsed, options)
  }
}

const choice = tag(choiceQuestion) as {
  <const T extends ChoiceCriteria>(
    instructions: Entry,
    criteria: T,
    options?: AskOptions,
  ): Askable<ChoiceQuestion<T>>
  (
    strings: Strings,
    ...values: unknown[]
  ): <const T extends ChoiceCriteria>(
    criteria: T,
    options?: AskOptions,
  ) => Askable<ChoiceQuestion<T>>
}

const score = tag(scoreQuestion) as {
  <const T extends ScoreCriteria>(
    instructions: Entry,
    criteria: T,
    options?: AskOptions,
  ): Askable<ScoreQuestion<T>>
  (
    strings: Strings,
    ...values: unknown[]
  ): <const T extends ScoreCriteria>(
    criteria: T,
    options?: AskOptions,
  ) => Askable<ScoreQuestion<T>>
}

export const chance = tag(noul) as {
  (
    instructions: Entry,
    criteria?: NoulQuestion['criteria'],
    options?: AskOptions,
  ): Askable<NoulQuestion>
  (
    strings: Strings,
    ...values: unknown[]
  ): (criteria?: NoulQuestion['criteria'], options?: AskOptions) => Askable<NoulQuestion>
}

/** Client options plus the chance needed for a true answer. */
export type AskIfOptions = AskOptions & {
  /** True when the chance is above this. Default `0.5`. */
  threshold?: number
}

/** Asks one yes/no question about the interpolated state; true when the chance is above the threshold. */
export function askIf(strings: Strings, ...values: unknown[]): Askable<IfQuestion>
export function askIf(
  options: AskIfOptions,
): (strings: Strings, ...values: unknown[]) => Askable<IfQuestion>
export function askIf(first: Strings | AskIfOptions, ...values: unknown[]) {
  return isTag(first)
    ? ifQuestion({}, first, values)
    : (strings: Strings, ...rest: unknown[]) => ifQuestion(first, strings, rest)
}

function ifQuestion(options: AskIfOptions, strings: Strings, values: unknown[]) {
  const parsed = parse(strings, values)
  const q: IfQuestion = {
    type: 'if',
    instructions: parsed.instructions,
    threshold: options.threshold ?? 0.5,
  }
  return askable(q, parsed, options)
}

function invalid(message: string): AskFailure {
  return { _tag: 'Err', failure: { _tag: 'Invalid', message } }
}

function missingCredentials(options: AskOptions): AskFailure | null {
  if (options.apiToken === undefined && env('CLOUDFLARE_API_TOKEN') === undefined)
    return invalid('Pass apiToken to ask() or set the CLOUDFLARE_API_TOKEN environment variable.')
  if (options.accountId === undefined && env('CLOUDFLARE_ACCOUNT_ID') === undefined)
    return invalid('Pass accountId to ask() or set the CLOUDFLARE_ACCOUNT_ID environment variable.')
  return null
}

// Optional: only runtimes with a Node-style `process.env` provide values. Blank values count as unset.
// Keep the bare global: importing `node:process` would break worker compatibility.
function env(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  // eslint-disable-next-line node/prefer-global/process -- the bare global keeps this worker-compatible
  return g.process?.env?.[name]?.trim() || undefined
}

ask.choice = choice
ask.score = score
ask.chance = chance
ask.if = askIf
