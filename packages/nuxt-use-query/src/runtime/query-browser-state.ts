import { createSharedComposable, useDocumentVisibility, useEventListener } from '@vueuse/core'
import { shallowRef } from 'vue'

// One browser event source per client app lifetime. `createSharedComposable`
// falls back to isolated state during SSR, preventing cross-request sharing.
export const useSharedQueryDocumentVisibility = createSharedComposable(useDocumentVisibility)
export const useSharedQueryReconnectSignal = createSharedComposable(() => {
  const signal = shallowRef(0)
  useEventListener('online', () => signal.value++)
  return signal
})
