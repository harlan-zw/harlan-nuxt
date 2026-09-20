import type { SystemOneResult } from '../src/runtime/core/questions'
import type { JevJournal, NewDecision } from '../src/runtime/server/decide'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noul } from '../src/runtime/core/questions'
import { resolveJevConfig } from '../src/runtime/server/config'
import { createInMemoryJevJournal, decideJev } from '../src/runtime/server/decide'

const CONFIGURED = resolveJevConfig({ apiToken: 'token', accountId: 'account' })

function jevResponse(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    success: true,
    result: { state: null, result: { model: 'typesafe/jev', answers, usage: { input_tokens: 10, output_tokens: 5 } } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const noulAnswer = (noul: number) => ({ type: 'noul', noul })

function recordingJournal(): { journal: JevJournal, inserted: NewDecision[] } {
  const base = createInMemoryJevJournal()
  const inserted: NewDecision[] = []
  return {
    inserted,
    journal: {
      find: key => base.find(key),
      insert: async (row) => {
        inserted.push(row)
        return base.insert(row)
      },
      isUniqueViolation: base.isUniqueViolation,
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => jevResponse({ brand: noulAnswer(0.91), q: noulAnswer(0.91) })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('decideJev', () => {
  it('asks, records the decision, and reuses the row on the same input without a second call', async () => {
    const { journal, inserted } = recordingJournal()
    const base = {
      journal,
      config: CONFIGURED,
      seat: 'brand-query',
      questionVersion: 'v1',
      subject: 'q:nuxtseo',
      state: { query: 'nuxtseo', brandTerms: ['nuxt seo'] },
      questions: { brand: noul('Is `query` a search for the site brand?') },
      siteId: 's_1',
    }
    const first = await decideJev(base)
    expect(first).toMatchObject({ _tag: 'Answer', provenance: 'model' })
    expect(first._tag === 'Answer' && first.answers.brand.noul).toBe(0.91)
    expect(first._tag === 'Answer' && first.decisionId).toMatch(/^[0-9a-f-]{36}$/)

    const second = await decideJev(base)
    expect(second).toMatchObject({ _tag: 'Answer', provenance: 'reuse' })

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      seat: 'brand-query',
      questionVersion: 'v1',
      provenance: 'model',
      model: 'typesafe/jev',
      siteId: 's_1',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: expect.any(Number),
      subjectDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      stateDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(inserted[0]?.stateSnapshot).toEqual({ query: 'nuxtseo', brandTerms: ['nuxt seo'] })
    expect(inserted[0]?.answers).toEqual({ brand: noulAnswer(0.91), q: noulAnswer(0.91) })
  })

  it('re-asks when the state changes under the same subject', async () => {
    const { journal, inserted } = recordingJournal()
    const base = {
      journal,
      config: CONFIGURED,
      seat: 'brand-query',
      questionVersion: 'v1',
      subject: 'q:nuxtseo',
      questions: { brand: noul() },
    }
    await decideJev({ ...base, state: { query: 'nuxtseo' } })
    await decideJev({ ...base, state: { query: 'nuxtseo pro' } })
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2)
    expect(inserted).toHaveLength(2)
  })

  it('re-asks when the question version changes under the same subject and state', async () => {
    const { journal, inserted } = recordingJournal()
    const base = {
      journal,
      config: CONFIGURED,
      seat: 'brand-query',
      subject: 'q:nuxtseo',
      state: { query: 'nuxtseo' },
      questions: { brand: noul() },
    }
    await decideJev({ ...base, questionVersion: 'v1' })
    await decideJev({ ...base, questionVersion: 'v2' })
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2)
    expect(inserted).toHaveLength(2)
  })

  it('returns Unavailable and writes no row when the gateway 500s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const { journal, inserted } = recordingJournal()
    const result = await decideJev({
      journal,
      config: CONFIGURED,
      seat: 'brand-query',
      questionVersion: 'v1',
      subject: 'q:x',
      state: { query: 'x' },
      questions: { brand: noul() },
    })
    expect(result).toMatchObject({ _tag: 'Unavailable', message: expect.stringContaining('500') })
    expect(inserted).toHaveLength(0)
  })

  it('treats a 2xx body without answers as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const inner: Partial<SystemOneResult> = { model: 'typesafe/jev', usage: { input_tokens: 1, output_tokens: 1 } }
      return new Response(JSON.stringify({ success: true, result: { state: null, result: inner } }), { status: 200 })
    }))
    const { journal, inserted } = recordingJournal()
    const result = await decideJev({
      journal,
      config: CONFIGURED,
      seat: 'brand-query',
      questionVersion: 'v1',
      subject: 'q:y',
      state: { query: 'y' },
      questions: { brand: noul() },
    })
    expect(result).toMatchObject({ _tag: 'Unavailable' })
    expect(inserted).toHaveLength(0)
  })

  it('returns Unconfigured without calling the network when no token is set', async () => {
    const { journal, inserted } = recordingJournal()
    const result = await decideJev({
      journal,
      config: resolveJevConfig({}),
      seat: 'brand-query',
      questionVersion: 'v1',
      subject: 'q:z',
      state: { query: 'z' },
      questions: { brand: noul() },
    })
    expect(result).toMatchObject({ _tag: 'Unconfigured' })
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
  })

  it('loses an insert race and reuses the winner row', async () => {
    const base = createInMemoryJevJournal()
    const ask = {
      journal: base,
      config: CONFIGURED,
      seat: 'race',
      questionVersion: 'v1',
      subject: 'sub',
      state: { a: 1 },
      questions: { q: noul() },
    }
    await decideJev(ask)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)

    let finds = 0
    const racing: JevJournal = {
      find: (key) => {
        finds++
        return finds === 1 ? Promise.resolve(undefined) : base.find(key)
      },
      insert: row => base.insert(row),
      isUniqueViolation: base.isUniqueViolation,
    }
    const result = await decideJev({ ...ask, journal: racing })
    expect(result).toMatchObject({ _tag: 'Answer', provenance: 'reuse' })
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2)
  })

  it('propagates journal errors that are not unique violations', async () => {
    const failing: JevJournal = {
      find: async () => undefined,
      insert: async () => {
        throw new Error('db offline')
      },
      isUniqueViolation: () => false,
    }
    await expect(decideJev({
      journal: failing,
      config: CONFIGURED,
      seat: 's',
      questionVersion: 'v1',
      subject: 'sub',
      state: null,
      questions: { q: noul() },
    })).rejects.toThrow('db offline')
  })
})

describe('createInMemoryJevJournal', () => {
  it('stores and finds rows by the decision key', async () => {
    const journal = createInMemoryJevJournal()
    const row = await journal.insert({
      seat: 's',
      subjectDigest: 'd',
      questionVersion: 'v1',
      stateDigest: 'sd',
      stateSnapshot: { a: 1 },
      answers: { q: { type: 'noul', noul: 0.5 } },
      provenance: 'model',
      model: 'typesafe/jev',
    })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(await journal.find({ seat: 's', subjectDigest: 'd', questionVersion: 'v1' })).toMatchObject({ id: row.id })
    expect(await journal.find({ seat: 's', subjectDigest: 'other', questionVersion: 'v1' })).toBeUndefined()
  })

  it('throws a unique-style error on a duplicate key and recognises it', async () => {
    const journal = createInMemoryJevJournal()
    const row = { seat: 's', subjectDigest: 'd', questionVersion: 'v1', stateDigest: 'sd', stateSnapshot: null, answers: {}, provenance: 'model' as const, model: 'm' }
    await journal.insert(row)
    const error = await journal.insert(row).catch((err: unknown) => err)
    expect(journal.isUniqueViolation(error)).toBe(true)
    expect(journal.isUniqueViolation(new Error('other'))).toBe(false)
  })
})
