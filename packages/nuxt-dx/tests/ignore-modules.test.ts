import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = new URL('..', import.meta.url)
const fixture = 'tests/fixtures/ignore-modules'

describe('ignoreModules', () => {
  it('keeps an ignored module in the report without warning', async () => {
    const result = await execFileAsync('pnpm', ['exec', 'nuxt', 'build', fixture], {
      cwd: packageRoot,
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 20 * 1024 * 1024,
    })
    const output = `${result.stdout}\n${result.stderr}`
    const report = JSON.parse(await readFile(new URL(`${fixture}/.nuxt/dx/size-budget.json`, packageRoot), 'utf8'))
    const ignored = report.entries.find((entry: { name?: string }) => entry.name === 'fixture-expensive-module')
    const enforced = report.entries.find((entry: { name?: string }) => entry.name === 'fixture-enforced-module')

    expect(ignored.totalBytes).toBeGreaterThan(0)
    expect(enforced.totalBytes).toBeGreaterThan(0)
    expect(output).not.toContain('fixture-expensive-module')
    expect(output).toContain('fixture-enforced-module')
  }, 60_000)
})
