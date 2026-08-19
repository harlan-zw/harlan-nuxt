import type { WideEventsRuntimeConfig } from '../../types'
import type { WideEventFields } from './index'
import type { BackgroundWideEvent } from './standalone-core'
import config from '#wide-events/config'
import { createBackgroundWideEvent } from './standalone-core'

const runtimeConfig = config as WideEventsRuntimeConfig

/** Create one production Wide Event for a background operation. */
export function createWideEvent(initialFields?: WideEventFields): BackgroundWideEvent {
  return createBackgroundWideEvent(initialFields, {
    ...(runtimeConfig.console ? { output: (record: unknown) => console.log(JSON.stringify(record)) } : {}),
    sampling: runtimeConfig.sampling,
    service: runtimeConfig.service,
  })
}
