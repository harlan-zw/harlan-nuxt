import { defineJob } from '@harlanzw/nuxt-cf-jobs/server'
import { createQueuedEventListenerContext } from '#domain-events/context'
import * as generatedEventRuntime from '#domain-events/server'
import { isPermanentQueuedDeliveryError, safeParseEventListenerEnvelope } from '../runtime'

const eventRuntime = generatedEventRuntime as typeof generatedEventRuntime & {
  handleQueuedListenerTerminalFailure: (
    envelope: Parameters<typeof generatedEventRuntime.deliverQueuedListener>[0],
    error: unknown,
    context: Parameters<typeof generatedEventRuntime.deliverQueuedListener>[1],
  ) => Promise<void>
}

/** One lazy cf-jobs definition delivers every queued listener by registry name. */
export default defineJob({
  name: 'events/deliver-listener',
  // Static registry locality only. The public outbox route override intentionally
  // persists and sends each listener record on its declared logical queue.
  queue: 'maintenance',
  input: { safeParse: safeParseEventListenerEnvelope },
  handle: async (envelope, jobContext) => {
    // The context resolver is host-owned so env, D1 and idempotency stay
    // explicit for each job attempt.
    const context = await createQueuedEventListenerContext(jobContext)
    await eventRuntime.deliverQueuedListener(envelope, context).catch(async (error: unknown) => {
      if (!isPermanentQueuedDeliveryError(error))
        throw error
      // nuxt-cf-jobs persists ctx.fail() first, then invokes this definition's
      // failed hook. The listener callback therefore cannot precede durable evidence.
      await jobContext.fail(describeError(error))
    })
  },
  failed: async (envelope, jobContext, error) => {
    const context = await createQueuedEventListenerContext(jobContext)
    await eventRuntime.handleQueuedListenerTerminalFailure(envelope, error, context)
  },
})

function describeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}
