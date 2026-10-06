import { describe, expect, it, vi } from 'vitest'
import { emitWideEvent, startWideEvent } from '../../nuxt-wide-events/src/runtime/server/index'

vi.mock('nitropack/runtime', () => ({ defineNitroPlugin: (setup: unknown) => setup }))

const addFields = vi.hoisted(() => vi.fn())

vi.mock('@harlan-zw/nuxt-wide-events/server', async importOriginal => ({
  ...await importOriginal<typeof import('../../nuxt-wide-events/src/runtime/server/index')>(),
  addWideEventFields: addFields,
}))

describe('cloudflare Wide Event fields', () => {
  it('omits values that the request did not provide', async () => {
    const { addWideEventFields } = await vi.importActual<typeof import('../../nuxt-wide-events/src/runtime/server/index')>('../../nuxt-wide-events/src/runtime/server/index')
    addFields.mockImplementation((event, fields) => {
      const addCompilerOwnedFields = addWideEventFields as unknown as (
        event: Parameters<typeof addWideEventFields>[0],
        fields: Parameters<typeof addWideEventFields>[1],
        owned: true,
      ) => void
      addCompilerOwnedFields(event, fields, true)
    })
    const { recordCloudflareWideEventFields } = await import('../src/runtime/server/plugins/wide-events')
    const request = {
      context: {
        cloudflare: {
          request: {
            cf: { colo: 'SYD' },
          },
        },
      },
      method: 'GET',
    }
    startWideEvent(request, 'req_1', 10)

    recordCloudflareWideEventFields(request as never)
    const record = emitWideEvent(request, 200, undefined, undefined, 11, 'now')!

    expect(record['cf.colo']).toBe('SYD')
    expect(Object.values(record)).not.toContain(null)
  })
})
