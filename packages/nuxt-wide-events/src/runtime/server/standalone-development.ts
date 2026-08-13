import type { WideEventFields } from './index'
import type { StandaloneWideEvent } from './standalone-core'
import { useNitroApp } from 'nitropack/runtime'
import config from '#wide-events/config'
import { drainWideEvent } from './drain'
import { createStandaloneWideEvent } from './standalone-core'

/** Create one development Wide Event for a background operation. */
export function createWideEvent(initialFields?: WideEventFields): StandaloneWideEvent {
  return createStandaloneWideEvent(initialFields, {
    ...(config.console || config.drain
      ? {
          output: async (record) => {
            if (config.console)
              console.log('Wide Event', record)
            if (config.drain)
              await drainWideEvent(useNitroApp(), record)
          },
        }
      : {}),
    service: config.service,
  })
}
