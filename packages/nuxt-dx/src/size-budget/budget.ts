import type { CostMeasurement } from './graph'

export interface BudgetVerdict {
  path: string
  /** The `name` from `defineNuxtPlugin`, when the plugin declares one. */
  name?: string
  /** Nuxt module that registered this runtime entry, when known. */
  owner?: string
  budgetBytes: number
  measurement: CostMeasurement
}

export interface BudgetOverride {
  /** A plugin name or any fragment of a runtime entry path. */
  fragment: string
  bytes: number
}

/**
 * The threshold below which nothing can possibly breach its budget. Used to skip
 * name resolution for plugins that are comfortably small.
 */
export function smallestBudget(defaultBytes: number, overrides: readonly BudgetOverride[]): number {
  return overrides.reduce((smallest, override) => Math.min(smallest, override.bytes), defaultBytes)
}

export function budgetFor(path: string, name: string | undefined, defaultBytes: number, overrides: readonly BudgetOverride[]): number {
  const normalized = path.replace(/\\/g, '/')
  // An override keyed by name wins over one keyed by a path fragment.
  const override = overrides.find(candidate => candidate.fragment === name)
    ?? overrides.find(candidate => normalized.includes(candidate.fragment))
  return override?.bytes ?? defaultBytes
}
