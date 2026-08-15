import type { WideEventFields } from './index'
import type { StandaloneWideEvent } from './standalone-core'
import config from '#wide-events/config'
import { writeDevelopmentWideEvent } from './development'
import { createStandaloneWideEvent } from './standalone-core'

/** Create one development Wide Event for a background operation. */
export function createWideEvent(initialFields?: WideEventFields): StandaloneWideEvent {
  return createStandaloneWideEvent(initialFields, {
    ...(config.console ? { output: writeDevelopmentWideEvent } : {}),
    service: config.service,
  })
}
