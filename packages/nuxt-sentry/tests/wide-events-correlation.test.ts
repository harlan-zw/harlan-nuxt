import { describe, expect, it, vi } from 'vitest'

const addWideEventFields = vi.fn()
const hooks: Record<string, (event: unknown) => void> = {}

vi.mock('#imports', () => ({ addWideEventFields }))
vi.mock('@sentry/cloudflare', () => ({ getTraceData: () => ({ 'sentry-trace': 'abc-def-1' }) }))
vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (plugin: (app: unknown) => void) => plugin,
}))

/**
 * The plugin runs only inside a consumer build, where a wrong call signature is caught
 * by the Wide Events build validator rather than by anything in this package. That is
 * how `addWideEventFields(fields)` shipped: the real API takes the event first.
 */
describe('wide events correlation plugin', () => {
  it('passes the request event before the fields', async () => {
    const plugin = (await import('../src/runtime/server/plugins/wide-events-correlation')).default
    plugin({ hooks: { hook: (name: string, handler: (event: unknown) => void) => { hooks[name] = handler } } } as never)

    const event = { path: '/api/thing' }
    hooks.request!(event)

    expect(addWideEventFields).toHaveBeenCalledTimes(1)
    const [first, second] = addWideEventFields.mock.calls[0]!
    expect(first).toBe(event)
    expect(second).toEqual({ 'sentry.traceId': 'abc', 'sentry.spanId': 'def' })
  })
})
