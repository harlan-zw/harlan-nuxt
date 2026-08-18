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
  'env'?: Record<string, string>
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

  it('writes the diff to the step summary', () => {
    expect(step('Compare against the baseline').run).toContain('"$GITHUB_STEP_SUMMARY"')
  })

  it('reports growth without failing the job unless asked to', () => {
    expect(action.inputs['fail-on-breach']!.default).toBe('false')
    // The comparison itself never decides the job's fate, so a breach still leaves a
    // summary, a comment and a new baseline behind.
    expect(step('Compare against the baseline').run).not.toMatch(/^\s*exit\b/m)
    const verdict = step('Apply the verdict').run!
    expect(verdict).toContain('FAIL_ON_BREACH')
    expect(verdict).toContain('::warning::')
  })

  it('still fails when the two reports could not be compared at all', () => {
    // Exit code 2 is a broken step, not growth, so no input makes it passable.
    expect(step('Apply the verdict').run).toMatch(/CODE" = "2"[\s\S]*?exit 1/)
  })

  it('decides the verdict after the baseline is uploaded, so a failure keeps it', () => {
    const names = action.runs.steps.map(candidate => candidate.name)
    expect(names.indexOf('Apply the verdict')).toBeGreaterThan(names.indexOf('Keep this report as the next baseline'))
  })

  it('replaces its own pull request comment instead of stacking them', () => {
    const comment = step('Comment the summary on the pull request')
    expect(comment.if).toContain('pull_request')
    expect(comment.run).toContain('$ENV.MARKER')
    // An HTML comment, so readers never see it, keyed by artifact name so a matrix
    // of apps gets one comment each rather than fighting over one.
    expect(comment.env!.MARKER).toMatch(/^<!-- nuxt-dx-size-budget:/)
    expect(comment.env!.MARKER).toContain('inputs.artifact-name')
    expect(comment.run).toContain('PATCH')
  })

  it('leaves the summary alone when it cannot comment, rather than failing', () => {
    expect(step('Comment the summary on the pull request').run).toContain('::notice::')
  })

  it('leaves this build\'s report behind even when the comparison failed', () => {
    const upload = step('Keep this report as the next baseline')
    expect(upload.uses).toContain('actions/upload-artifact')
    expect(upload.if).toContain('!cancelled()')
  })
})
