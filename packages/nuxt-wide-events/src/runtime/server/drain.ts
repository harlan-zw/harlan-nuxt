import type { NitroApp } from 'nitropack/types'
import type { WideEventRecord } from './index'

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'wide-events:emit': (record: WideEventRecord) => void | Promise<void>
  }
}

interface WideEventDrainContext {
  waitUntil: (promise: Promise<unknown>) => void
}

export async function drainWideEvent(app: NitroApp, record: WideEventRecord): Promise<void> {
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
