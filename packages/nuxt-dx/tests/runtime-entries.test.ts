import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = new URL('..', import.meta.url)
const fixture = 'tests/fixtures/runtime-entries'

describe('runtime entry budgets', () => {
  it('measures plugins and middleware registered by the app and Nuxt modules', async () => {
    const result = await execFileAsync('pnpm', ['exec', 'nuxt', 'build', fixture], {
      cwd: packageRoot,
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 20 * 1024 * 1024,
    })
    const output = `${result.stdout}\n${result.stderr}`
    const report = JSON.parse(await readFile(new URL(`${fixture}/.nuxt/dx/size-budget.json`, packageRoot), 'utf8'))
    const owned = report.entries.filter((entry: { owner?: string }) => entry.owner === 'fixture-runtime-module')

    expect(new Set(report.entries.map((entry: { scope: string }) => entry.scope))).toEqual(new Set([
      'client',
      'client-middleware',
      'nitro',
      'nitro-middleware',
    ]))
    expect(new Set(owned.map((entry: { scope: string }) => entry.scope))).toEqual(new Set([
      'client',
      'client-middleware',
      'nitro',
      'nitro-middleware',
    ]))
    expect(output).toMatch(/Nuxt plugins? over budget/)
    expect(output).toContain('Nuxt middleware over budget')
    expect(output).toMatch(/Nitro plugins? over budget/)
    expect(output).toContain('Nitro middleware over budget')
  }, 60_000)
})
