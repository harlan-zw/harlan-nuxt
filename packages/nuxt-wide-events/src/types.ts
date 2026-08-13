export interface ModuleOptions {
  /** Emit Wide Events. */
  enabled?: boolean
  /** Collect one Wide Event for each request. */
  request?: boolean
  /** Fields that application code may add. Use dotted lower camel case paths. */
  fields?: string[]
  /** Add a stable service name to every Wide Event. */
  service?: string
  /** Route glob patterns to exclude. */
  exclude?: string[]
  /** Reduce production Wide Event volume after the request completes. */
  sampling?: WideEventSamplingConfig
  /** Write each Wide Event as one JSON line to stdout. */
  console?: boolean
  /** Call the wide-events:emit hook after each request. */
  drain?: boolean
}

export interface WideEventSamplingRates {
  debug?: number
  error?: number
  info?: number
  warn?: number
}

export interface WideEventTailSamplingCondition {
  /** Keep requests with at least this duration in milliseconds. */
  duration?: number
  /** Keep requests with at least this status code. */
  status?: number
}

export interface WideEventSamplingConfig {
  /** Percentage of each level to keep, from 0 to 100. */
  rates?: WideEventSamplingRates
  /** Conditions that bypass percentage sampling. */
  keep?: WideEventTailSamplingCondition[]
}

export interface WideEventsRuntimeSampling {
  debug?: number
  duration?: number
  error?: number
  info?: number
  status?: number
  warn?: number
}

export interface WideEventsRuntimeConfig {
  console: boolean
  drain: boolean
  exclude?: RegExp
  sampling?: WideEventsRuntimeSampling
  service?: string
}
