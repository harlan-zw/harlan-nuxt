import type {
  ModuleOptions,
  WideEventSamplingRates,
  WideEventsRuntimeConfig,
  WideEventsRuntimeSampling,
  WideEventTailSamplingCondition,
} from '../types'

type RuntimeOptions = Pick<ModuleOptions, 'console' | 'drain' | 'exclude' | 'sampling' | 'service'>

export function resolveWideEventsRuntimeConfig(options: RuntimeOptions): WideEventsRuntimeConfig {
  const exclude = compileRoutePatterns(options.exclude)
  const sampling = resolveSampling(options.sampling?.rates, options.sampling?.keep)
  return {
    console: options.console ?? true,
    drain: options.drain ?? false,
    ...(options.service === undefined ? {} : { service: options.service }),
    ...(exclude === undefined ? {} : { exclude }),
    ...(sampling === undefined ? {} : { sampling }),
  }
}

export function serializeWideEventsRuntimeConfig(config: WideEventsRuntimeConfig): string {
  const { exclude, ...serializable } = config
  if (exclude === undefined)
    return `export default ${JSON.stringify(serializable)}\n`
  const properties = JSON.stringify(serializable).slice(1, -1)
  return `export default {${properties},"exclude":new RegExp(${JSON.stringify(exclude.source)})}\n`
}

function compileRoutePatterns(patterns: string[] | undefined): RegExp | undefined {
  if (!patterns?.length)
    return undefined
  return new RegExp(`^(?:${patterns.map(globSource).join('|')})$`)
}

function globSource(pattern: string): string {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*')
    .replaceAll('?', '[^/]')
}

function resolveSampling(
  rates: WideEventSamplingRates | undefined,
  keep: WideEventTailSamplingCondition[] | undefined,
): WideEventsRuntimeSampling | undefined {
  for (const [level, rate] of Object.entries(rates ?? {}))
    parseRate(level, rate)
  for (const [index, condition] of (keep ?? []).entries()) {
    if (condition.duration !== undefined && (!Number.isFinite(condition.duration) || condition.duration < 0))
      throw new TypeError(`wideEvents.sampling.keep[${index}].duration must be a finite nonnegative number.`)
    if (condition.status !== undefined && (!Number.isInteger(condition.status) || condition.status < 0))
      throw new TypeError(`wideEvents.sampling.keep[${index}].status must be a nonnegative integer.`)
  }

  const duration = minimum(keep?.map(condition => condition.duration))
  const status = minimum(keep?.map(condition => condition.status))
  const info = rates?.info
  const error = rates?.error
  const debug = rates?.debug
  const warn = rates?.warn
  if (duration === undefined && status === undefined && info === undefined && error === undefined && debug === undefined && warn === undefined)
    return undefined
  return {
    ...(debug === undefined ? {} : { debug }),
    ...(duration === undefined ? {} : { duration }),
    ...(error === undefined ? {} : { error }),
    ...(info === undefined ? {} : { info }),
    ...(status === undefined ? {} : { status }),
    ...(warn === undefined ? {} : { warn }),
  }
}

function parseRate(level: string, rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100)
    throw new TypeError(`wideEvents.sampling.rates.${level} must be a finite number from 0 to 100.`)
}

function minimum(values: (number | undefined)[] | undefined): number | undefined {
  let result: number | undefined
  for (const value of values ?? []) {
    if (value !== undefined && (result === undefined || value < result))
      result = value
  }
  return result
}
