import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = new URL('..', import.meta.url)
const fixture = 'tests/fixtures/runtime-entries'
const terminalEvents = new URL(`${fixture}/.nuxt/dx/terminal-events.jsonl`, packageRoot)
const terminalHost = new URL('fixtures/terminal-host.mjs', import.meta.url)

describe('runtime entry budgets', () => {
  it('measures plugins and middleware registered by the app and Nuxt modules', async () => {
    await rm(terminalEvents, { force: true })
    await execFileAsync('pnpm', ['exec', 'nuxt', 'build', fixture], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${terminalHost.href}`].filter(Boolean).join(' '),
        NUXT_DX_TERMINAL_EVENTS: fileURLToPath(terminalEvents),
        NO_COLOR: '1',
      },
      maxBuffer: 20 * 1024 * 1024,
    })
    const report = JSON.parse(await readFile(new URL(`${fixture}/.nuxt/dx/size-budget.json`, packageRoot), 'utf8'))
    const terminal = (await readFile(terminalEvents, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
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
    expect(terminal.filter(event => event.type === 'notification')).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warn', title: 'Nuxt DX diagnostic', message: expect.stringMatching(/Nuxt plugins? over budget/) }),
      expect.objectContaining({ level: 'warn', title: 'Nuxt DX diagnostic', message: expect.stringContaining('Nuxt middleware over budget') }),
      expect.objectContaining({ level: 'warn', title: 'Nuxt DX diagnostic', message: expect.stringMatching(/Nitro plugins? over budget/) }),
      expect.objectContaining({ level: 'warn', title: 'Nuxt DX diagnostic', message: expect.stringContaining('Nitro middleware over budget') }),
    ]))
    expect(terminal.filter(event => event.type === 'task:stop')).toEqual(expect.arrayContaining([
      { type: 'task:stop', message: 'Checked client runtime size budgets' },
      { type: 'task:stop', message: 'Checked server runtime size budgets' },
    ]))
  }, 60_000)
})
