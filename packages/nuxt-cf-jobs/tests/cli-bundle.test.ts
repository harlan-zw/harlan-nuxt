import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

// Guards the class of bug where a CLI helper reached only through a subcommand
// (e.g. `renderWorkerDashboard`, used solely by `cf-jobs work --watch`) gets
// tree-shaken out of the bundle — defined in source, missing in dist → a runtime
// `ReferenceError` that source-level unit tests can't see. Only meaningful after
// a build, so it's skipped when dist is absent.
const distPath = resolve(process.cwd(), 'dist/cli/index.mjs')
const hasDist = existsSync(distPath)

describe.skipIf(!hasDist)('built cli bundle', () => {
  const bundle = hasDist ? readFileSync(distPath, 'utf8') : ''

  it('keeps the dashboard renderer the work command calls', () => {
    expect(bundle).toMatch(/\bfunction renderWorkerDashboard\b/)
    // No bundler rename-collision (e.g. `renderWorkerDashboard$1`) that would
    // leave the bare call site dangling.
    expect(bundle).not.toMatch(/renderWorkerDashboard\$\d/)
  })
})
