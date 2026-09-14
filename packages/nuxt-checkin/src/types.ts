import type { ExternalOptions } from './runtime/external/index'

export interface ModuleOptions {
  /** Defaults to each Nuxt layer's server/checks directory. */
  dirs?: string[]
  external?: ExternalOptions
  build?: { required?: string[], timeoutMs?: number, totalTimeoutMs?: number }
}

export interface CheckRegistration {
  id: string
  execution?: 'server' | 'build' | 'external'
  /** Absolute module path exporting a default factory. */
  handler: string
  /** Public factory options. Must contain only JSON values. Never include credentials. */
  options?: Record<string, unknown>
}

export interface CheckRegistry {
  add: (registration: CheckRegistration) => void
}
