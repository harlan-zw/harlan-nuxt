import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The composite action consumers paste into their own workflow. It cannot be executed
 * here, so what is asserted is the contract it makes: it parses, it pins what it runs,
 * and it treats a missing baseline as a pass.
 */
const file = fileURLToPath(new URL('../../../.github/actions/nuxt-dx-budget/action.yml', import.meta.url))
const source = readFileSync(file, 'utf-8')

interface ActionStep {
  'name'?: string
  'uses'?: string
  'run'?: string
  'if'?: string
  'continue-on-error'?: boolean
}

const action = parse(source) as {
  inputs: Record<string, { description: string, default?: string }>
  runs: { using: string, steps: ActionStep[] }
}

function step(name: string): ActionStep {
  const found = action.runs.steps.find(candidate => candidate.name === name)
  expect(found, `no step named "${name}"`).toBeDefined()
  return found!
}

describe('nuxt-dx-budget action', () => {
  it('is a composite action, so it drops into a job that already built the app', () => {
    expect(action.runs.using).toBe('composite')
    expect(action.runs.steps.some(candidate => /pnpm|npm|yarn|nuxi/.test(candidate.run ?? '') && /\bbuild\b/.test(candidate.run ?? ''))).toBe(false)
  })

  it('describes every input and gives each one a default', () => {
    for (const [name, input] of Object.entries(action.inputs)) {
      expect(input.description, `${name} has no description`).toBeTruthy()
      expect(input.default, `${name} has no default`).toBeDefined()
    }
    expect(action.inputs['report-path']!.default).toBe('.nuxt/dx/size-budget.json')
    expect(action.inputs['threshold-kb']!.default).toBe('10')
  })

  it('pins every action it runs to a commit, with the version it came from', () => {
    const used = action.runs.steps.filter(candidate => candidate.uses).map(candidate => candidate.uses!)
    expect(used.length).toBeGreaterThan(0)
    for (const uses of used)
      expect(uses, `${uses} is not pinned to a commit`).toMatch(/@[0-9a-f]{40}$/)
    for (const uses of used)
      expect(source).toMatch(new RegExp(`${uses.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} # v\\d+\\.\\d+\\.\\d+`))
  })

  it('reads the baseline from the last green run on the base branch', () => {
    expect(step('Find the baseline run').run).toContain('gh run list')
    expect(step('Find the baseline run').run).toContain('--status success')
    expect(step('Download the baseline report').uses).toContain('actions/download-artifact')
  })

  it('treats a missing or expired baseline as a pass', () => {
    expect(step('Download the baseline report')['continue-on-error']).toBe(true)
    expect(step('Compare against the baseline').run).toContain('--allow-missing-base')
  })

  it('writes the diff to the step summary and fails on the comparison, not on tee', () => {
    const run = step('Compare against the baseline').run!
    expect(run).toContain('"$GITHUB_STEP_SUMMARY"')
    expect(run).toMatch(/exit "\$\{PIPESTATUS\[0\]\}"/)
  })

  it('leaves this build\'s report behind even when the comparison failed', () => {
    const upload = step('Keep this report as the next baseline')
    expect(upload.uses).toContain('actions/upload-artifact')
    expect(upload.if).toContain('!cancelled()')
  })
})
