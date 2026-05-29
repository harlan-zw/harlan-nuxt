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

  it('reads from named-const form with numeric maxAttempts', () => {
    const code = `const j = defineJob({ queue: 'sync-standard', maxAttempts: 5 }); export default j`
    const meta = extractJobMeta(code)
    expect(meta).toEqual({
      queue: 'sync-standard',
      maxAttempts: 5,
      hasInput: false,
      hasUniqueId: false,
    })
  })

  it('reads boolean unique and detects input/uniqueId keys (export const form)', () => {
    const code = `export const x = defineJob({ name: 'a/b', queue: 'c', unique: true, input: someSchema, uniqueId: (p) => p.id })`
    const meta = extractJobMeta(code)
    expect(meta).toEqual({
      queue: 'c',
      unique: true,
      hasInput: true,
      hasUniqueId: true,
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

  it('leaves queue undefined when value is a non-literal identifier', () => {
    const meta = extractJobMeta(`export default defineJob({ queue: someVar })`)
    expect(meta).toEqual({
      hasInput: false,
      hasUniqueId: false,
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

  it('reads tries and all literal fields together', () => {
    const code = `export default defineJob({ queue: 'q', jobType: 'jt', tries: 3, maxAttempts: 7, unique: false })`
    expect(extractJobMeta(code)).toEqual({
      queue: 'q',
      jobType: 'jt',
      tries: 3,
      maxAttempts: 7,
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

  it('ignores non-literal numeric and boolean values', () => {
    const code = `export default defineJob({ queue: 'q', maxAttempts: COUNT, unique: flag })`
    expect(extractJobMeta(code)).toEqual({
      queue: 'q',
      hasInput: false,
      hasUniqueId: false,
    })
  })
})
