import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import {
  useSharedQueryDocumentVisibility,
  useSharedQueryReconnectSignal,
} from '../src/runtime/query-browser-state'

const factories = vi.hoisted(() => ({
  eventListener: vi.fn(),
  visibility: vi.fn(() => ({ value: 'visible' })),
}))

vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vueuse/core')>()
  return {
    ...actual,
    useEventListener: factories.eventListener,
    useDocumentVisibility: factories.visibility,
  }
})

describe('query browser state performance', () => {
  beforeEach(() => {
    factories.eventListener.mockClear()
    factories.visibility.mockClear()
  })

  it('shares one browser source across query component scopes', () => {
    const scopes = Array.from({ length: 100 }, () => effectScope())

    for (const scope of scopes) {
      scope.run(() => {
        useSharedQueryDocumentVisibility()
        useSharedQueryReconnectSignal()
      })
    }

    expect(factories.visibility).toHaveBeenCalledOnce()
    expect(factories.eventListener).toHaveBeenCalledOnce()

    for (const scope of scopes)
      scope.stop()
  })
})
