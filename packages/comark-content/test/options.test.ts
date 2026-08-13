import { describe, expect, it } from 'vitest'
import { assertSupportedOptions, defineCollection } from '../src/config'

describe('configuration boundary', () => {
  it('rejects non-Markdown data collections', () => {
    expect(() => defineCollection({ type: 'data' as 'page', source: '**/*.json' })).toThrow('Markdown page collections are the only supported collection type')
  })

  it('reports database configuration as unsupported at its source', () => {
    expect(() => assertSupportedOptions({ database: { type: 'd1' } }, '/site/nuxt.config.ts')).toThrow('/site/nuxt.config.ts:1:1')
  })
})
