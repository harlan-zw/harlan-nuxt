declare module '#domain-events/context' {
  import type { QueuedDeliveryContext } from '../types'

  export function createQueuedEventListenerContext(jobContext: unknown): QueuedDeliveryContext | Promise<QueuedDeliveryContext>
}

declare module '#domain-events/server' {
  import type { EventListenerEnvelope, QueuedDeliveryContext } from '../types'

  export function deliverQueuedListener(envelope: EventListenerEnvelope, context: QueuedDeliveryContext): Promise<void>
}
