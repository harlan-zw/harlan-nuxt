// Jev question and answer types. Wire shapes mirror typesafe-sdk-js and are
// measured against the live Cloudflare /ai/run endpoint.
//
// Jev is a System One judge: it answers typed questions about one state with
// probabilities. It never generates text. Do not use it for math, extraction,
// or anything without a safe direction.

/** A JSON-serializable value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Text, a JSON object or array, or `null` for state, instructions, and criteria. */
export type Entry = string | Json[] | { [key: string]: Json } | null

/** A yes/no question answered with a probability. */
export interface NoulQuestion {
  type: 'noul'
  /** A question or statement to judge as true. */
  instructions?: Entry
  /** Optional descriptions of what counts as true or false. */
  criteria?: { true?: Entry, false?: Entry } | null
}

/** Option labels mapped to their descriptions; requires 2 to 255 options. */
export interface ChoiceCriteria { [label: string]: Entry }

/** A question that selects one labeled option. */
export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  type: 'choice'
  /** What to decide from the state. */
  instructions?: Entry
  /** 2 to 255 option labels and descriptions; both are sent to the model. */
  criteria: T
}

/** At least two descriptions indexed by score from zero. */
export type ScoreCriteria = readonly [Entry, Entry, ...Entry[]]

/** A question rated against 2 to 10 ordered score levels. */
export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  type: 'score'
  /** What to rate in the state. */
  instructions?: Entry
  /** 2 to 10 level descriptions, numbered by array position from zero. */
  criteria: T
}

/** A supported evaluation question. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Named questions evaluated together against the same state. */
export interface Questions { [name: string]: Question }

export function noul(instructions: Entry = null, criteria?: NoulQuestion['criteria']): NoulQuestion {
  return {
    type: 'noul',
    instructions,
    ...(criteria === undefined ? {} : { criteria }),
  }
}

export function choice<const T extends ChoiceCriteria>(instructions: Entry, criteria: T): ChoiceQuestion<T> {
  return { type: 'choice', instructions, criteria }
}

export function score<const T extends ScoreCriteria>(instructions: Entry, criteria: T): ScoreQuestion<T> {
  return { type: 'score', instructions, criteria }
}

// --- answers ---

/** The probability that a yes/no question is true. */
export interface NoulAnswer {
  readonly type: 'noul'
  /** Probability of a yes answer, from zero to one. */
  readonly noul: number
}

/** The selected option and probability of each choice. */
export interface ChoiceAnswer<T extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: 'choice'
  /** The label of the highest-probability option. */
  readonly choice: keyof T & string
  /** How much the top option stands out, from zero to one. */
  readonly confidence: number
  /** Probability of each option, keyed by its label. */
  readonly probabilities: { readonly [label in keyof T]: number }
}

export type ScoreOf<T extends ScoreCriteria> = number extends T['length']
  ? number
  : Extract<keyof T, `${number}`>

/** The expected score, rubric, and probability of each level. */
export interface ScoreAnswer<T extends ScoreCriteria = ScoreCriteria> {
  readonly type: 'score'
  /** Sum of each level number times its probability; may fall between levels. */
  readonly score: number
  /** How much the top level stands out, from zero to one. */
  readonly confidence: number
  readonly legend: { readonly [score in ScoreOf<T>]: T[score] }
  readonly probabilities: { readonly [score in ScoreOf<T>]: number }
}

/** The answer for any question type. */
export type AnyAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type AnswerFor<T extends Question> = T extends NoulQuestion
  ? NoulAnswer
  : T extends ScoreQuestion<infer S>
    ? ScoreAnswer<S>
    : T extends ChoiceQuestion<infer C>
      ? ChoiceAnswer<C>
      : never

export interface SystemOneRequest<Q extends Questions = Questions> {
  state: Entry
  questions: Q
  model?: string
}

export interface SystemOneResult<Q extends Questions = Questions> {
  readonly model: string
  readonly answers: { readonly [K in keyof Q]: AnswerFor<Q[K]> }
  readonly usage: { readonly input_tokens: number, readonly output_tokens: number }
}

export interface JevModelResult {
  state: unknown
  result: { answers: Record<string, unknown>, model?: unknown, usage?: unknown }
}

/** One answer reduced to the scalar a seat can journal. */
export type SeatScalar
  = | { kind: 'choice', value: string }
    | { kind: 'noul', value: number }
    | { kind: 'score', value: number }

export function answerScalar(answer: AnyAnswer): SeatScalar | null {
  if (answer.type === 'choice' && typeof answer.choice === 'string')
    return { kind: 'choice', value: answer.choice }
  if (answer.type === 'noul' && Number.isFinite(answer.noul))
    return { kind: 'noul', value: answer.noul }
  if (answer.type === 'score' && Number.isFinite(answer.score))
    return { kind: 'score', value: answer.score }
  return null
}

export function answerConfidence(answer: AnyAnswer): number | null {
  // Choice and score answers carry a derived confidence. Noul answers do not:
  // the probability IS the signal, so confidence is its distance from the
  // coin-flip (0.5 -> 0.5, 0.97 -> 0.97), matching how bands gate them.
  if (answer.type === 'noul')
    return Number.isFinite(answer.noul) ? Math.max(answer.noul, 1 - answer.noul) : null
  const c = (answer as { confidence?: unknown }).confidence
  return Number.isFinite(c as number) ? c as number : null
}

export function validateAnswers<Q extends Questions>(questions: Q, answers: Record<string, unknown>): string | null {
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name]
    if (typeof answer !== 'object' || answer === null || typeof (answer as { type?: unknown }).type !== 'string')
      return `Answer "${name}" is not a typed answer.`
    if (question.type === 'choice') {
      const { choice, confidence } = answer as { choice?: unknown, confidence?: unknown }
      if (typeof choice !== 'string' || !(choice in question.criteria))
        return `Answer "${name}" does not name one of its criteria.`
      if (!Number.isFinite(confidence) || (confidence as number) < 0 || (confidence as number) > 1)
        return `Answer "${name}" carries no confidence between zero and one.`
    }
    else if (question.type === 'score') {
      if (!Number.isFinite((answer as { score?: unknown }).score))
        return `Answer "${name}" carries no numeric score.`
    }
    else if (!Number.isFinite((answer as { noul?: unknown }).noul)) {
      return `Answer "${name}" carries no numeric probability.`
    }
  }
  return null
}
