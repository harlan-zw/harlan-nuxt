import { describe, expect, it } from 'vitest'
import { assertSupportedOptions, defineCollection } from '../src/config'
import { contentComponentDirectories } from '../src/components'

describe('configuration boundary', () => {
  it('finds unprefixed content component directories in layer priority order', () => {
    expect(contentComponentDirectories([
      { config: { srcDir: '/app' } },
      { config: { srcDir: '/layer' } },
    ])).toEqual(['/layer/components/content', '/app/components/content'])
  })

  it('rejects non-Markdown data collections', () => {
    expect(() => defineCollection({ type: 'data' as 'page', source: '**/*.json' })).toThrow('Markdown page collections are the only supported collection type')
  })

  it('reports database configuration as unsupported at its source', () => {
    expect(() => assertSupportedOptions({ database: { type: 'd1' } }, '/site/nuxt.config.ts')).toThrow('/site/nuxt.config.ts:1:1')
  })
})
