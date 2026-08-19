import type { CostMeasurement } from './graph'
import type { BudgetScope } from './scope'
import { knownBudgetBytes } from './known-budgets'

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
  /** A plugin name, a Nuxt module name, or any fragment of a runtime entry path. */
  fragment: string
  bytes: number
}

/** What an override fragment is matched against. */
export interface BudgetSubject {
  path: string
  name?: string
  owner?: string
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/')
}

/** True when the fragment names the entry, names the module that registered it, or sits in its path. */
export function overrideMatches(fragment: string, subject: BudgetSubject): boolean {
  return fragment === subject.name
    || fragment === subject.owner
    || normalize(subject.path).includes(fragment)
}

/**
 * The threshold below which nothing can possibly breach its budget. Used to skip
 * name resolution for plugins that are comfortably small.
 */
export function smallestBudget(defaultBytes: number, overrides: readonly BudgetOverride[]): number {
  return overrides.reduce((smallest, override) => Math.min(smallest, override.bytes), defaultBytes)
}

export function budgetFor(scope: BudgetScope, subject: BudgetSubject, defaultBytes: number, overrides: readonly BudgetOverride[]): number {
  // An override keyed by name beats one keyed by module, which beats one keyed by a path fragment.
  const override = overrides.find(candidate => candidate.fragment === subject.name)
    ?? overrides.find(candidate => candidate.fragment === subject.owner)
    ?? overrides.find(candidate => normalize(subject.path).includes(candidate.fragment))
  if (override)
    return override.bytes
  return Math.max(defaultBytes, knownBudgetBytes(scope, subject) ?? 0)
}
