export interface ModuleOptions {
  /** Emit Wide Events. */
  enabled?: boolean
  /** Fields that application code may add. Use dotted lower camel case paths. */
  fields?: string[]
  /** Add a stable service name to every Wide Event. */
  service?: string
  /** Write each Wide Event as one JSON line to stdout. */
  console?: boolean
}

export interface WideEventsRuntimeConfig {
  console: boolean
  service?: string
}
