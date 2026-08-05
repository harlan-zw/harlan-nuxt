declare module '#event-listeners/context' {
  import type { QueuedDeliveryContext } from '../types'

  export function createQueuedEventListenerContext(jobContext: unknown): QueuedDeliveryContext | Promise<QueuedDeliveryContext>
}

declare module '#event-listeners/server' {
  import type { EventListenerEnvelope, QueuedDeliveryContext } from '../types'

  export function deliverQueuedListener(envelope: EventListenerEnvelope, context: QueuedDeliveryContext): Promise<void>
}
