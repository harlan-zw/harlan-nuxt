import type { WideEventsRuntimeConfig } from '../../types'
import type { WideEventFields } from './index'
import type { StandaloneWideEvent } from './standalone-core'
import { useNitroApp } from 'nitropack/runtime'
import config from '#wide-events/config'
import { drainWideEvent } from './drain'
import { createStandaloneWideEvent } from './standalone-core'

const runtimeConfig = config as WideEventsRuntimeConfig

/** Create one production Wide Event for a background operation. */
export function createWideEvent(initialFields?: WideEventFields): StandaloneWideEvent {
  return createStandaloneWideEvent(initialFields, {
    ...(runtimeConfig.console || runtimeConfig.drain
      ? {
          output: async (record) => {
            if (runtimeConfig.console)
              console.log(JSON.stringify(record))
            if (runtimeConfig.drain)
              await drainWideEvent(useNitroApp(), record)
          },
        }
      : {}),
    sampling: runtimeConfig.sampling,
    service: runtimeConfig.service,
  })
}
