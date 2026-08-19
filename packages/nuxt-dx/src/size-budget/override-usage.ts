import type { BudgetOverride, BudgetSubject } from './budget'
import { overrideMatches } from './budget'

export interface OverrideUsage {
  /** Marks every fragment these entries match as used. */
  use: (subjects: readonly BudgetSubject[]) => void
  /** Fragments no measured entry matched. Each one changes no budget. */
  unused: () => string[]
}

/**
 * An override keyed to something the build never measured silences nothing. The warning it
 * was written for keeps firing, and nothing says the key is dead. Tracking what each fragment
 * matched turns a typo, a renamed plugin, or a deleted file into one warning.
 */
export function createOverrideUsage(overrides: readonly BudgetOverride[]): OverrideUsage {
  const unused = new Set(overrides.map(override => override.fragment))
  return {
    use: (subjects) => {
      for (const fragment of unused) {
        if (subjects.some(subject => overrideMatches(fragment, subject)))
          unused.delete(fragment)
      }
    },
    unused: () => [...unused],
  }
}
