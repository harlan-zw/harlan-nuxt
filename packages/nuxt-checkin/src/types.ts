export interface ModuleOptions {
  /** Defaults to each Nuxt layer's server/checks directory. */
  dirs?: string[]
}

export interface CheckRegistration {
  id: string
  /** Absolute module path exporting a default factory. */
  handler: string
  /** Public factory options. Must contain only JSON values. Never include credentials. */
  options?: Record<string, unknown>
}

export interface CheckRegistry {
  add: (registration: CheckRegistration) => void
}
