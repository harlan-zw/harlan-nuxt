import type { NitroApp } from 'nitropack/types'
import type { BackgroundWideEventRecord, WideEventRecord } from './index'

type DrainedWideEventRecord = BackgroundWideEventRecord | WideEventRecord

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'wide-events:emit': (record: DrainedWideEventRecord) => void | Promise<void>
  }
}

interface WideEventDrainContext {
  waitUntil: (promise: Promise<unknown>) => void
}

export async function drainWideEvent(app: NitroApp, record: DrainedWideEventRecord): Promise<void> {
  await app.hooks.callHookParallel('wide-events:emit', record)
}

export function scheduleWideEventDrain(
  app: NitroApp,
  context: WideEventDrainContext,
  record: WideEventRecord,
): void {
  context.waitUntil(drainWideEvent(app, record).catch((error: unknown) => {
    // The drain owns the only durable copy of this record, so report why it was lost.
    console.error('[nuxt-wide-events] Wide Event drain failed.', error)
  }))
}
