import type { ReplayAnswer, ReplaySample, ReplaySummary } from '../src/eval'
import { describe, expect, it } from 'vitest'
import { agreement, replayAnswer, suggestBand, summarizeReplay } from '../src/eval'

function sample(opts: {
  journaled?: { kind: 'noul' | 'choice' | 'score', value: string | number } | null
  replay?: ReplayAnswer
  outcome?: string | null
}): ReplaySample {
  const journaled = opts.journaled === undefined ? { kind: 'noul' as const, value: 0.9 } : opts.journaled
  return {
    inputDigest: crypto.randomUUID(),
    stateJson: '{}',
    choice: journaled?.kind === 'choice' ? journaled.value as string : null,
    noul: journaled?.kind === 'noul' ? journaled.value as number : null,
    score: journaled?.kind === 'score' ? journaled.value as number : null,
    confidence: null,
    outcome: opts.outcome ?? null,
    ...(opts.replay === undefined ? {} : { replay: opts.replay }),
  }
}

function answered(value: number | string, confidence: number, kind: 'noul' | 'choice' | 'score' = 'noul'): ReplayAnswer {
  return { _tag: 'answered', scalar: { kind, value }, confidence }
}

describe('replayAnswer', () => {
  it('derives noul confidence as distance from the coin-flip', () => {
    expect(replayAnswer({ type: 'noul', noul: 0.97 })).toMatchObject({ _tag: 'answered', confidence: 0.97 })
    expect(replayAnswer({ type: 'noul', noul: 0.03 })).toMatchObject({ _tag: 'answered', confidence: 0.97 })
    expect(replayAnswer({ type: 'noul', noul: 0.5 })).toMatchObject({ _tag: 'answered', confidence: 0.5 })
  })

  it('keeps the carried confidence for choice and score answers', () => {
    expect(replayAnswer({ type: 'choice', choice: 'a', confidence: 0.8 })).toMatchObject({ _tag: 'answered', scalar: { kind: 'choice', value: 'a' }, confidence: 0.8 })
    expect(replayAnswer({ type: 'score', score: 2, confidence: 0.7 })).toMatchObject({ _tag: 'answered', scalar: { kind: 'score', value: 2 }, confidence: 0.7 })
  })

  it('marks missing or unusable answers unavailable', () => {
    expect(replayAnswer(undefined)).toEqual({ _tag: 'unavailable' })
    expect(replayAnswer(null)).toEqual({ _tag: 'unavailable' })
    expect(replayAnswer({ type: 'choice', choice: 'a' })).toEqual({ _tag: 'unavailable' })
  })
})

describe('agreement', () => {
  it('compares choice answers exactly', () => {
    expect(agreement({ kind: 'choice', value: 'yes' }, { kind: 'choice', value: 'yes' }, 'choice')).toBe(true)
    expect(agreement({ kind: 'choice', value: 'yes' }, { kind: 'choice', value: 'no' }, 'choice')).toBe(false)
  })

  it('compares noul and score answers within 0.1', () => {
    expect(agreement({ kind: 'noul', value: 0.5 }, { kind: 'noul', value: 0.55 }, 'noul')).toBe(true)
    expect(agreement({ kind: 'noul', value: 0.5 }, { kind: 'noul', value: 0.7 }, 'noul')).toBe(false)
    expect(agreement({ kind: 'score', value: 1 }, { kind: 'score', value: 1.05 }, 'score')).toBe(true)
    expect(agreement({ kind: 'score', value: 1 }, { kind: 'score', value: 1.2 }, 'score')).toBe(false)
  })

  it('never agrees across kinds', () => {
    expect(agreement({ kind: 'noul', value: 0.5 }, { kind: 'choice', value: 'x' }, 'noul')).toBe(false)
  })
})

describe('summarizeReplay', () => {
  it('counts agreement, bands, unavailability, and outcomes', () => {
    const summary = summarizeReplay([
      sample({ journaled: { kind: 'noul', value: 0.9 }, replay: answered(0.9, 0.97), outcome: 'confirm' }),
      sample({ journaled: { kind: 'noul', value: 0.9 }, replay: answered(0.9, 0.97), outcome: 'contradict' }),
      sample({ journaled: { kind: 'noul', value: 0.9 }, replay: answered(0.6, 0.6) }),
      sample({ journaled: { kind: 'noul', value: 0.9 }, replay: { _tag: 'unavailable' } }),
      sample({ journaled: null, replay: answered(0.9, 0.9) }),
      sample({ journaled: { kind: 'noul', value: 0.9 } }),
    ])
    expect(summary.sampleSize).toBe(6)
    expect(summary.answeredCount).toBe(3)
    expect(summary.agreeCount).toBe(2)
    expect(summary.unavailableCount).toBe(1)
    expect(summary.outcomeAccuracy).toEqual({ n: 2, correct: 1 })
    expect(summary.bandAgreement['0.60']).toEqual({ n: 3, agree: 2 })
    expect(summary.bandAgreement['0.65']).toEqual({ n: 2, agree: 2 })
    expect(summary.bandAgreement['0.95']).toEqual({ n: 2, agree: 2 })
    expect(summary.bandAgreement['1.00']).toBeUndefined()
  })
})

describe('suggestBand', () => {
  const summaryOf = (overrides: Partial<ReplaySummary>): ReplaySummary => ({
    sampleSize: 30,
    answeredCount: 30,
    agreeCount: 30,
    unavailableCount: 0,
    bandAgreement: { 0.85: { n: 12, agree: 12 } },
    outcomeAccuracy: null,
    ...overrides,
  })

  it('suggests the smallest band meeting every minimum', () => {
    expect(suggestBand(summaryOf({}))).toBe(0.85)
  })

  it('needs at least 30 answered samples', () => {
    expect(suggestBand(summaryOf({ answeredCount: 29 }))).toBeNull()
  })

  it('needs at least 10 samples in the band', () => {
    expect(suggestBand(summaryOf({ bandAgreement: { '0.85': { n: 9, agree: 9 }, '0.90': { n: 10, agree: 10 } } }))).toBe(0.90)
    expect(suggestBand(summaryOf({ bandAgreement: { 0.85: { n: 9, agree: 9 } } }))).toBeNull()
  })

  it('needs at least 95 percent agreement in the band', () => {
    expect(suggestBand(summaryOf({ bandAgreement: { 0.85: { n: 20, agree: 18 } } }))).toBeNull()
    expect(suggestBand(summaryOf({ bandAgreement: { 0.85: { n: 20, agree: 19 } } }))).toBe(0.85)
  })

  it('vetoes every suggestion when 10 or more outcomes sit below 90 percent accuracy', () => {
    expect(suggestBand(summaryOf({ outcomeAccuracy: { n: 10, correct: 8 } }))).toBeNull()
    expect(suggestBand(summaryOf({ outcomeAccuracy: { n: 9, correct: 0 } }))).toBe(0.85)
    expect(suggestBand(summaryOf({ outcomeAccuracy: { n: 10, correct: 9 } }))).toBe(0.85)
  })
})
