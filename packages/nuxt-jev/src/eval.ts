// Eval replay math: re-asks journaled decisions under the current question
// version and measures agreement, banded by confidence, plus accuracy against
// recorded outcomes where they exist. Pure math over data the caller supplies;
// the replay job is the shell.
//
// Self-improvement contract:
// - A suggestion is evidence, never an action. Promoting a band is a separate
//   audited step.
// - Unavailable answers count nowhere. A broken service run must not read as
//   agreement.
// - Suggestions only ever name a band the data supports; with no outcome data
//   the suggestion stays null and the seat keeps its shipped band.

/** The question kinds eval can compare. */
export type EvalQuestionKind = 'choice' | 'noul' | 'score'

/** One answer reduced to the scalar eval can journal and compare. */
export interface EvalScalar {
  kind: EvalQuestionKind
  value: string | number
}

/** A raw jev answer, as `./core` returns it. */
export interface EvalAnswerInput {
  type: EvalQuestionKind
  choice?: string
  noul?: number
  score?: number
  confidence?: number
}

export type ReplayAnswer
  = | { _tag: 'answered', scalar: EvalScalar, confidence: number }
    | { _tag: 'unavailable' }

export interface ReplaySample {
  inputDigest: string
  stateJson: string
  choice: string | null
  noul: number | null
  score: number | null
  confidence: number | null
  outcome: string | null
  /** The re-asked answer; absent when the sample was not re-asked. */
  replay?: ReplayAnswer
}

export interface BandAgreement {
  n: number
  agree: number
}

export interface ReplaySummary {
  sampleSize: number
  answeredCount: number
  agreeCount: number
  unavailableCount: number
  /** Confidence band floor ("0.85") -> agreement counts. */
  bandAgreement: Record<string, BandAgreement>
  /** Over answered samples carrying an outcome; null when there are none. */
  outcomeAccuracy: { n: number, correct: number } | null
}

const AGREE_RATE = 0.95
const AGREE_EPSILON = 0.1

/** Reduce one raw jev answer to what eval can count, or mark it unavailable. */
export function replayAnswer(answer: EvalAnswerInput | undefined | null): ReplayAnswer {
  if (answer === undefined || answer === null)
    return { _tag: 'unavailable' }
  const scalar = scalarOfAnswer(answer)
  const confidence = confidenceOfAnswer(answer)
  if (scalar === null || confidence === null)
    return { _tag: 'unavailable' }
  return { _tag: 'answered', scalar, confidence }
}

/** Choice answers must match exactly; noul and score agree within 0.1. */
export function agreement(prev: EvalScalar, next: EvalScalar, kind: EvalQuestionKind): boolean {
  if (prev.kind !== kind || next.kind !== kind)
    return false
  if (kind === 'choice')
    return prev.value === next.value
  return Math.abs(Number(prev.value) - Number(next.value)) <= AGREE_EPSILON
}

/** Summarise re-asked answers against the journal rows they came from. */
export function summarizeReplay(samples: ReplaySample[]): ReplaySummary {
  const bands = new Map<number, { n: number, agree: number }>()
  let answered = 0
  let agreeTotal = 0
  let unavailable = 0
  let outcomeN = 0
  let outcomeCorrect = 0

  for (const sample of samples) {
    const journaled = scalarOfSample(sample)
    const re = sample.replay
    if (journaled === null || re === undefined || re._tag === 'unavailable') {
      if (re?._tag === 'unavailable')
        unavailable++
      continue
    }
    answered++
    const ok = agreement(journaled, re.scalar, journaled.kind)
    if (ok)
      agreeTotal++
    if (sample.outcome !== null) {
      outcomeN++
      // Outcome semantics: the journaled answer was confirmed ('confirm') or
      // contradicted ('contradict') by observed ground truth.
      if (sample.outcome === 'confirm')
        outcomeCorrect++
    }
    // Integer steps keep the bands exact (0.5 + 0.05 * n drifts in floats and
    // a 0.6-confidence answer must land in the 0.6 band, not below it).
    for (let step = 10; step <= 20; step++) {
      const band = step / 20
      if (re.confidence >= band - 1e-9) {
        const slot = bands.get(round(band)) ?? { n: 0, agree: 0 }
        slot.n++
        if (ok)
          slot.agree++
        bands.set(round(band), slot)
      }
    }
  }

  const bandAgreement: Record<string, BandAgreement> = {}
  for (const [band, counts] of [...bands.entries()].sort((a, b) => a[0] - b[0]))
    bandAgreement[band.toFixed(2)] = counts

  return {
    sampleSize: samples.length,
    answeredCount: answered,
    agreeCount: agreeTotal,
    unavailableCount: unavailable,
    bandAgreement,
    outcomeAccuracy: outcomeN > 0 ? { n: outcomeN, correct: outcomeCorrect } : null,
  }
}

/**
 * Smallest 0.05-step band (0.50 to 1.00) with at least 30 answered samples
 * overall, at least 10 in the band, and at least 95% agreement in the band;
 * null when the data cannot support one. Ten or more outcomes below 90%
 * accuracy vetoes every suggestion.
 */
export function suggestBand(summary: ReplaySummary): number | null {
  if (summary.answeredCount < 30)
    return null
  const outcome = summary.outcomeAccuracy
  if (outcome !== null && outcome.n >= 10 && outcome.correct / outcome.n < 0.9)
    return null
  const bands = Object.entries(summary.bandAgreement).sort((a, b) => Number(a[0]) - Number(b[0]))
  for (const [band, counts] of bands) {
    if (counts.n < 10)
      continue
    if (counts.agree / counts.n >= AGREE_RATE)
      return Number(band)
  }
  return null
}

function scalarOfSample(sample: Pick<ReplaySample, 'choice' | 'noul' | 'score'>): EvalScalar | null {
  if (sample.choice !== null)
    return { kind: 'choice', value: sample.choice }
  if (sample.noul !== null)
    return { kind: 'noul', value: sample.noul }
  if (sample.score !== null)
    return { kind: 'score', value: sample.score }
  return null
}

function scalarOfAnswer(answer: EvalAnswerInput): EvalScalar | null {
  if (answer.type === 'choice')
    return typeof answer.choice === 'string' ? { kind: 'choice', value: answer.choice } : null
  if (answer.type === 'noul')
    return typeof answer.noul === 'number' && Number.isFinite(answer.noul) ? { kind: 'noul', value: answer.noul } : null
  return typeof answer.score === 'number' && Number.isFinite(answer.score) ? { kind: 'score', value: answer.score } : null
}

function confidenceOfAnswer(answer: EvalAnswerInput): number | null {
  // Choice and score answers carry a derived confidence. Noul answers do not:
  // the probability IS the signal, so confidence is its distance from the
  // coin-flip (0.5 -> 0.5, 0.97 -> 0.97), matching how bands gate them.
  if (answer.type === 'noul')
    return typeof answer.noul === 'number' && Number.isFinite(answer.noul) ? Math.max(answer.noul, 1 - answer.noul) : null
  return typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : null
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
