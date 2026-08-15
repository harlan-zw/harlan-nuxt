import type { WideEventFields } from './index'
import type { StandaloneWideEvent } from './standalone-core'
import { createStandaloneWideEvent } from './standalone-core'

export type {
  StandaloneWideEvent,
  StandaloneWideEventLevel,
  StandaloneWideEventRecord,
} from './standalone-core'

/** Create one production Wide Event for a background operation. */
export function createWideEvent(initialFields?: WideEventFields): StandaloneWideEvent {
  return createStandaloneWideEvent(initialFields, {
    output: record => console.log(JSON.stringify(record)),
  })
}
