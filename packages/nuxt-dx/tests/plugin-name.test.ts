import { describe, expect, it } from 'vitest'
import { extractPluginName } from '../src/size-budget/plugin-name'

const file = '/app/plugins/analytics.ts'

describe('extractPluginName', () => {
  it('reads a name off the plugin object', () => {
    expect(extractPluginName(file, `
      export default defineNuxtPlugin({
        name: 'analytics',
        setup() {},
      })
    `)).toBe('analytics')
  })

  it('reads a name off the second meta argument', () => {
    expect(extractPluginName(file, `
      export default defineNuxtPlugin(() => {}, { name: 'analytics' })
    `)).toBe('analytics')
  })

  it('prefers the plugin object over the meta argument, matching Nuxt', () => {
    expect(extractPluginName(file, `
      export default defineNuxtPlugin({ name: 'from-object', setup() {} }, { name: 'from-meta' })
    `)).toBe('from-object')
  })

  it('supports definePayloadPlugin', () => {
    expect(extractPluginName(file, `
      export default definePayloadPlugin({ name: 'revivers', setup() {} })
    `)).toBe('revivers')
  })

  it('returns undefined for an anonymous function plugin', () => {
    expect(extractPluginName(file, `
      export default defineNuxtPlugin(() => {})
    `)).toBeUndefined()
  })

  it('ignores a computed or non-literal name', () => {
    expect(extractPluginName(file, `
      const id = 'analytics'
      export default defineNuxtPlugin({ name: id, setup() {} })
    `)).toBeUndefined()
  })

  it('returns undefined rather than throwing on unparsable source', () => {
    expect(extractPluginName(file, 'export default defineNuxtPlugin({{{')).toBeUndefined()
  })
})
