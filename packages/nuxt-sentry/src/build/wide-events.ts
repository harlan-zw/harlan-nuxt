import type { WideEventDrainPolicy, WideEventLogLevel } from '../runtime/shared/types'

/**
 * Build time resolution of the Wide Events drain.
 *
 * Sentry meters Logs as its own byte quota, so every level a site adds here is
 * money it chooses to spend. The default is the narrowest useful set.
 */

/** What a site writes for `wideEvents` in `nuxt.config.ts`. */
export type WideEventsOption = boolean | { levels?: WideEventLogLevel[] }

/** Errors only. A warning is a Wide Event the site already keeps in its own sink. */
export const DEFAULT_WIDE_EVENT_LEVELS: readonly WideEventLogLevel[] = ['error']

const WIDE_EVENT_LEVELS: readonly string[] = ['warn', 'error']

/**
 * Parse the option into a policy, or `null` when the drain is off.
 *
 * Parse, do not validate. An unknown level throws here, at build time, rather
 * than silently forwarding nothing on a deployed Worker.
 */
export function resolveWideEventDrain(option: WideEventsOption | undefined): WideEventDrainPolicy | null {
  if (!option)
    return null

  const levels = option === true ? undefined : option.levels
  if (levels === undefined)
    return { levels: [...DEFAULT_WIDE_EVENT_LEVELS] }

  for (const level of levels) {
    if (!WIDE_EVENT_LEVELS.includes(level))
      throw new TypeError(`nuxtSentry.wideEvents.levels must hold only "warn" or "error", not "${level}"`)
  }
  return { levels: [...new Set(levels)] }
}
