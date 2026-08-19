import type { WideEventFields } from './index'
import type { BackgroundWideEvent } from './standalone-core'
import { createBackgroundWideEvent } from './standalone-core'

export type { BackgroundWideEventRecord, WideEventLevel } from './index'
export type { BackgroundWideEvent, DrainedBackgroundWideEvent } from './standalone-core'

/**
 * Create one Wide Event for a background operation, outside Nuxt.
 *
 * Inside Nitro this entry point resolves to the configured variant, so the
 * record keeps the `service`, `console`, `sampling`, and `drain` options.
 */
export function createWideEvent(initialFields?: WideEventFields): BackgroundWideEvent {
  return createBackgroundWideEvent(initialFields, {
    output: record => console.log(JSON.stringify(record)),
  })
}
