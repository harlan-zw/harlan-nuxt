import type { WideEventFields } from './index'
import type { BackgroundWideEvent } from './standalone-core'
import config from '#wide-events/config'
import { writeDevelopmentWideEvent } from './development'
import { createBackgroundWideEvent } from './standalone-core'

/** Create one development Wide Event for a background operation. */
export function createWideEvent(initialFields?: WideEventFields): BackgroundWideEvent {
  return createBackgroundWideEvent(initialFields, {
    ...(config.console ? { output: writeDevelopmentWideEvent } : {}),
    service: config.service,
  })
}
