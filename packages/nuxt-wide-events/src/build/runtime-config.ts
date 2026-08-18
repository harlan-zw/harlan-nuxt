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
  const drain = options.drain ?? false
  return {
    // A drain owns the record, so console output would duplicate it.
    console: options.console ?? !drain,
    drain,
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

const TRAILING_GLOBSTAR = '\u0001'
const GLOBSTAR = '\u0002'

function globSource(pattern: string): string {
  // A trailing `/**` also matches the bare prefix, which is how Nitro matches routes.
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*\*$/, TRAILING_GLOBSTAR)
    .replaceAll('**', GLOBSTAR)
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll(GLOBSTAR, '.*')
    .replaceAll(TRAILING_GLOBSTAR, '(?:/.*)?')
}

function resolveSampling(
  rates: WideEventSamplingRates | undefined,
  keep: WideEventTailSamplingCondition[] | undefined,
): WideEventsRuntimeSampling | undefined {
  for (const [level, rate] of Object.entries(rates ?? {}))
    parseRate(level, rate)
  const conditions = (keep ?? []).map(parseCondition)

  const info = rates?.info
  const error = rates?.error
  const debug = rates?.debug
  const warn = rates?.warn
  if (conditions.length === 0 && info === undefined && error === undefined && debug === undefined && warn === undefined)
    return undefined
  return {
    ...(debug === undefined ? {} : { debug }),
    ...(error === undefined ? {} : { error }),
    ...(info === undefined ? {} : { info }),
    ...(conditions.length === 0 ? {} : { keep: conditions }),
    ...(warn === undefined ? {} : { warn }),
  }
}

function parseRate(level: string, rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100)
    throw new TypeError(`wideEvents.sampling.rates.${level} must be a finite number from 0 to 100.`)
}

function parseCondition(condition: WideEventTailSamplingCondition, index: number): WideEventTailSamplingCondition {
  if (condition.duration !== undefined && (!Number.isFinite(condition.duration) || condition.duration < 0))
    throw new TypeError(`wideEvents.sampling.keep[${index}].duration must be a finite nonnegative number.`)
  if (condition.status !== undefined && (!Number.isInteger(condition.status) || condition.status < 0))
    throw new TypeError(`wideEvents.sampling.keep[${index}].status must be a nonnegative integer.`)
  if (condition.duration === undefined && condition.status === undefined)
    throw new TypeError(`wideEvents.sampling.keep[${index}] must set duration, status, or both.`)
  return {
    ...(condition.duration === undefined ? {} : { duration: condition.duration }),
    ...(condition.status === undefined ? {} : { status: condition.status }),
  }
}
