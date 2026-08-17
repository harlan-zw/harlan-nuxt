import type { SizeBudgetSnapshot } from '../src/size-budget/snapshot'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli/index'
import { SNAPSHOT_VERSION } from '../src/size-budget/snapshot'

function snapshot(totalBytes: number): SizeBudgetSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    entries: [{ scope: 'client', path: 'layers/saas/app/plugins/a.ts', ownBytes: 512, exclusiveBytes: totalBytes - 512, totalBytes }],
  }
}

/**
 * The CLI is only ever run as a process, so what it writes and the code it leaves behind
 * are the whole contract. Both are captured here rather than asserted on internals.
 */
async function compare(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  try {
    await runCommand(main, { rawArgs: ['compare', ...args] })
    return { code: process.exitCode ?? 0, stdout: stdout.join(''), stderr: stderr.join('') }
  }
  finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
}

let dir: string
let base: string
let head: string
const originalExitCode = process.exitCode

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nuxt-dx-cli-'))
  base = join(dir, 'base.json')
  head = join(dir, 'head.json')
  process.exitCode = 0
})

afterEach(() => {
  process.exitCode = originalExitCode
})

describe('nuxt-dx compare', () => {
  it('fails when one target grew past the threshold', async () => {
    await writeFile(base, JSON.stringify(snapshot(10_000)))
    await writeFile(head, JSON.stringify(snapshot(40_000)))
    const { code, stdout } = await compare([base, head, '--threshold-kb', '10'])
    expect(code).toBe(1)
    expect(stdout).toContain('layers/saas/app/plugins/a.ts')
  })

  it('passes when nothing grew past the threshold', async () => {
    await writeFile(base, JSON.stringify(snapshot(10_000)))
    await writeFile(head, JSON.stringify(snapshot(11_000)))
    expect((await compare([base, head, '--threshold-kb', '10'])).code).toBe(0)
  })

  it('treats a baseline written in an older format as no baseline, so the next run can replace it', async () => {
    await writeFile(base, JSON.stringify({ ...snapshot(10_000), version: SNAPSHOT_VERSION - 1 }))
    await writeFile(head, JSON.stringify(snapshot(400_000)))
    const { code, stdout } = await compare([base, head, '--allow-missing-base'])
    expect(code).toBe(0)
    expect(stdout).toContain('cannot be read')
    expect(stdout).toContain(`format ${SNAPSHOT_VERSION - 1}`)
  })

  it('treats a truncated baseline as no baseline', async () => {
    await writeFile(base, '{"version":3,"entries":[')
    await writeFile(head, JSON.stringify(snapshot(400_000)))
    expect((await compare([base, head, '--allow-missing-base'])).code).toBe(0)
  })

  it('treats an absent baseline as no baseline', async () => {
    await writeFile(head, JSON.stringify(snapshot(400_000)))
    const { code, stdout } = await compare([base, head, '--allow-missing-base'])
    expect(code).toBe(0)
    expect(stdout).toContain('No baseline report was found')
  })

  it('refuses an unreadable baseline when it was not told to allow one', async () => {
    await writeFile(base, JSON.stringify({ ...snapshot(10_000), version: SNAPSHOT_VERSION - 1 }))
    await writeFile(head, JSON.stringify(snapshot(10_000)))
    const { code, stderr } = await compare([base, head])
    expect(code).toBe(2)
    expect(stderr).toContain('--allow-missing-base')
  })

  it('fails without comparing when the head report is the unreadable one', async () => {
    await writeFile(base, JSON.stringify(snapshot(10_000)))
    await writeFile(head, 'not json')
    expect((await compare([base, head, '--allow-missing-base'])).code).toBe(2)
  })
})
