import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Execute the action shell steps with controlled process boundaries.
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
  if (!found)
    throw new Error(`No step named ${name}`)
  return found
}

/**
 * GitHub runs `shell: bash` as `bash -e`, which a `set -uo pipefail` inside the script
 * does not undo. A breach used to end the step on the failing command, so the named
 * status was never written and `fail-on-breach: false` could not hold.
 */
describe('compare step under a -e shell', () => {
  it.each([[0, 'ok'], [1, 'breach'], [2, 'broken'], [126, 'broken'], [137, 'broken']])('maps CLI exit %i to %s', (code, status) => {
    const directory = mkdtempSync(join(tmpdir(), 'nuxt-dx-action-'))
    const cli = join(directory, 'fake-cli')
    writeFileSync(cli, `#!/usr/bin/env bash\necho "### report"\nexit ${code}\n`, { mode: 0o755 })
    const script = join(directory, 'compare.sh')
    writeFileSync(script, step('Compare against the baseline').run!)

    const output = join(directory, 'output')
    writeFileSync(output, '')
    execFileSync('bash', ['-e', script], {
      env: {
        ...process.env,
        CLI: cli,
        BASE_REPORT: 'base.json',
        HEAD_REPORT: 'head.json',
        THRESHOLD_KB: '10',
        SUMMARY_FILE: join(directory, 'summary.md'),
        GITHUB_STEP_SUMMARY: join(directory, 'step-summary.md'),
        GITHUB_OUTPUT: output,
      },
    })

    expect(readFileSync(output, 'utf-8')).toContain(`status=${status}`)
  })
})

describe('report identity', () => {
  it('uses the checked-out commit and isolates each invocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nuxt-dx-identity-'))
    execFileSync('git', ['init', '-q', directory])
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'test: initial'], { cwd: directory })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
    const outputs = [1, 2].map((attempt) => {
      const output = join(directory, `output-${attempt}`)
      execFileSync('bash', ['-e', '-c', step('Identify this report').run!], {
        cwd: directory,
        env: { ...process.env, RUNNER_TEMP: directory, GITHUB_SHA: 'f'.repeat(40), ARTIFACT_NAME: 'app-prod', REPORT_PATH: '.nuxt/dx/size-budget.json', GITHUB_OUTPUT: output },
      })
      return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')))
    })
    expect(outputs[0]!.sha).toBe(sha)
    expect(outputs[0]!['artifact-name']).toBe(`app-prod--${sha}`)
    expect(outputs[0]!.directory).not.toBe(outputs[1]!.directory)
  })
})
