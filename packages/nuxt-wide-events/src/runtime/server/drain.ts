import type { NitroApp } from 'nitropack/types'
import type { WideEventRecord } from './index'
import type { StandaloneWideEventRecord } from './standalone-core'

type DrainedWideEventRecord = StandaloneWideEventRecord | WideEventRecord

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
  context.waitUntil(drainWideEvent(app, record).catch(() => {
    console.error('[nuxt-wide-events] Wide Event drain failed.')
  }))
}
