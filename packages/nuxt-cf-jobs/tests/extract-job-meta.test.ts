import { describe, expect, it } from 'vitest'
import { extractJobMeta } from '../src/build/extract-job-meta'

describe('extractJobMeta', () => {
  it('reads queue from direct export default defineJob', () => {
    const meta = extractJobMeta(`export default defineJob({ queue: 'q' })`)
    expect(meta).toEqual({
      queue: 'q',
      hasInput: false,
      hasUniqueId: false,
    })
  })

  it('reads from named-const form and reports the removed maxAttempts key', () => {
    const code = `const j = defineJob({ queue: 'sync-standard', maxAttempts: 5 }); export default j`
    const meta = extractJobMeta(code)
    expect(meta).toEqual({
      queue: 'sync-standard',
      hasInput: false,
      hasUniqueId: false,
      unreadable: ['maxAttempts'],
    })
  })

  it('reads boolean unique and detects input/uniqueId keys (export const form)', () => {
    const code = `export const x = defineJob({ name: 'a/b', queue: 'c', unique: true, input: someSchema, uniqueId: (p) => p.id })`
    const meta = extractJobMeta(code)
    expect(meta).toEqual({
      name: 'a/b',
      queue: 'c',
      unique: true,
      hasInput: true,
      hasUniqueId: true,
    })
  })

  it('reads a string-literal name (namespaced) and leaves it undefined otherwise', () => {
    expect(extractJobMeta(`export default defineJob({ name: 'pro:reconcile-stripe-customer', queue: 'billing' })`)).toEqual({
      name: 'pro:reconcile-stripe-customer',
      queue: 'billing',
      hasInput: false,
      hasUniqueId: false,
    })
    // Non-literal (computed/identifier) name is ignored, so the registry falls
    // back to the file-path name.
    const computed = extractJobMeta(`export default defineJob({ name: NAME, queue: 'q' })`)
    expect(computed.name).toBeUndefined()
    expect(computed.unreadable).toEqual(['name'])
  })

  it('reads static template literal strings', () => {
    expect(extractJobMeta('export default defineJob({ name: `a/b`, queue: `q`, jobType: `jt` })')).toEqual({
      name: 'a/b',
      queue: 'q',
      jobType: 'jt',
      hasInput: false,
      hasUniqueId: false,
    })
  })

  it('leaves queue undefined when missing', () => {
    const meta = extractJobMeta(`export default defineJob({ jobType: 'foo' })`)
    expect(meta).toEqual({
      jobType: 'foo',
      hasInput: false,
      hasUniqueId: false,
    })
    expect(meta.queue).toBeUndefined()
  })

  it('reports queue as unreadable when the value is a non-literal identifier', () => {
    const meta = extractJobMeta(`export default defineJob({ queue: someVar })`)
    expect(meta).toEqual({
      hasInput: false,
      hasUniqueId: false,
      unreadable: ['queue'],
    })
    expect(meta.queue).toBeUndefined()
  })

  it('returns all-default object when no defineJob call exists', () => {
    const meta = extractJobMeta(`export default { queue: 'q', maxAttempts: 5 }`)
    expect(meta).toEqual({
      hasInput: false,
      hasUniqueId: false,
    })
  })

  it('reads every literal field together', () => {
    const code = `export default defineJob({ queue: 'q', jobType: 'jt', tries: 3, unique: false })`
    expect(extractJobMeta(code)).toEqual({
      queue: 'q',
      jobType: 'jt',
      tries: 3,
      unique: false,
      hasInput: false,
      hasUniqueId: false,
    })
  })

  it('returns all-default object on parse error', () => {
    expect(extractJobMeta(`export default defineJob({ queue: `)).toEqual({
      hasInput: false,
      hasUniqueId: false,
    })
  })

  it('reports non-literal numeric and boolean values instead of dropping them silently', () => {
    const code = `export default defineJob({ queue: 'q', tries: COUNT, unique: flag })`
    expect(extractJobMeta(code)).toEqual({
      queue: 'q',
      hasInput: false,
      hasUniqueId: false,
      unreadable: ['tries', 'unique'],
    })
  })
})
