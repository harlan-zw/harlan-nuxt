import { describe, expect, it, vi } from 'vitest'

// The `?instance` suffix is built at runtime (never a string literal) so
// vite-node treats each call as a distinct module in its graph, while tsc
// never tries to resolve it as a static specifier.
async function importErrorsModule(instance: string) {
  return import(/* @vite-ignore */ `../src/runtime/server/errors?${instance}`) as Promise<typeof import('../src/runtime/server/errors')>
}

describe('event runtime error guard', () => {
  it('recognises an error created by a different module instance', async () => {
    // Simulates the 2026-09-15 incident: a peer hash change made pnpm resolve
    // two copies of this package, so an error thrown by one copy's
    // eventRuntimeError() was not recognised by the other copy's
    // isEventRuntimeError(). Each dynamic import below with a distinct query
    // string forces vite-node to evaluate a fresh module instance, standing
    // in for "a second copy of the package".
    vi.resetModules()
    const instanceA = await importErrorsModule('instanceA')
    vi.resetModules()
    const instanceB = await importErrorsModule('instanceB')

    const error = instanceA.eventRuntimeError('UnknownEvent', 'boom')

    expect(instanceA.isEventRuntimeError(error)).toBe(true)
    expect(instanceB.isEventRuntimeError(error)).toBe(true)
  })

  it('still rejects an error that was never branded', async () => {
    const { isEventRuntimeError } = await import('../src/runtime/server/errors')

    expect(isEventRuntimeError(new Error('plain failure'))).toBe(false)
  })

  it('still rejects a non-Error thrown value carrying a matching _tag', async () => {
    const { isEventRuntimeError } = await import('../src/runtime/server/errors')

    expect(isEventRuntimeError({ _tag: 'UnknownEvent' })).toBe(false)
  })
})
