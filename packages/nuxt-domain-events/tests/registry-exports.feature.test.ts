import { describe, expect, it } from 'vitest'
import { renderEventRegistry } from '../src/build/registry'
import { createGeneratedEventRegistry } from '../src/runtime/server/registry'
import { createGeneratedEventRuntime } from '../src/runtime/server/runtime'

/**
 * The generated registry re-exports the runtime by hand, so a function added to the
 * runtime is easy to leave behind. A caller importing the missing name then fails at
 * build, with nothing in the module to point at.
 */
describe('generated registry exports', () => {
  it('re-exports every function the runtime provides', () => {
    const registry = createGeneratedEventRegistry({ manifestHash: 'hash', events: [], listeners: [] })
    const runtime = createGeneratedEventRuntime(registry, { observe: () => {}, observerFallback: () => {} })
    const entries = runtime as unknown as Record<string, unknown>
    const provided = Object.keys(entries).filter(key => typeof entries[key] === 'function')

    const rendered = renderEventRegistry({ manifestHash: 'hash', events: [], listeners: [], allowExternalEvents: false })
    const exported = [...rendered.matchAll(/export const (\w+) = runtime\.\w+/g)].map(match => match[1])

    expect(exported.toSorted()).toEqual(provided.toSorted())
  })
})
