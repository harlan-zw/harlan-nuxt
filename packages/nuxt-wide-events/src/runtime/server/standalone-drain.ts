import type { WideEventsRuntimeConfig } from '../../types'
import type { WideEventFields } from './index'
import type { DrainedStandaloneWideEvent } from './standalone-core'
import { useNitroApp } from 'nitropack/runtime'
import config from '#wide-events/config'
import { writeDevelopmentWideEvent } from './development'
import { drainWideEvent } from './drain'
import { createDrainedStandaloneWideEvent } from './standalone-core'

const runtimeConfig = config as WideEventsRuntimeConfig

/** Create one drained Wide Event for a background operation. */
export function createWideEvent(initialFields?: WideEventFields): DrainedStandaloneWideEvent {
  return createDrainedStandaloneWideEvent(initialFields, {
    output: async (record) => {
      if (runtimeConfig.console) {
        if (import.meta.dev)
          writeDevelopmentWideEvent(record)
        else
          console.log(JSON.stringify(record))
      }
      await drainWideEvent(useNitroApp(), record)
    },
    sampling: runtimeConfig.sampling,
    service: runtimeConfig.service,
  })
}
