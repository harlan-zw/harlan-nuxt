import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/run'

async function fixture(result: string) {
  const root = await mkdtemp(join(tmpdir(), 'checkin-cli-'))
  const artifact = join(root, 'checks.mjs')
  await writeFile(artifact, `export default [{id:'one',run:()=>(${result})}];export const options={required:['one'],save:{dir:'archive',stateFile:'state.json',timestampKey:'lastRun',baseline:'daily'}}`)
  return { root, artifact }
}
describe('shared CLI', () => {
  it('archives every attempt and preserves the first successful daily baseline', async () => {
    const { root, artifact } = await fixture('{_tag:\'Pass\',evidence:{}}')
    try {
      const stdout = (text: string) => {
        expect(JSON.parse(text).coverage).toBe('complete')
      }
      expect(await runCli(['--artifact', artifact, '--save'], { cwd: root, stdout, clock: () => new Date('2026-09-15T01:00:00Z') })).toBe(0)
      expect(await runCli(['--artifact', artifact, '--save'], { cwd: root, stdout, clock: () => new Date('2026-09-15T02:00:00Z') })).toBe(0)
      expect(JSON.parse(await readFile(join(root, 'archive/state.json'), 'utf8')).lastRun).toBe('2026-09-15T01:00:00.000Z')
    }
    finally { await rm(root, { recursive: true }) }
  })
  it('returns incomplete status without creating a success baseline', async () => {
    const { root, artifact } = await fixture('{_tag:\'Unavailable\',reason:\'Missing token.\'}')
    try {
      expect(await runCli(['--artifact', artifact, '--save'], { cwd: root, stdout: () => {} })).toBe(2)
      await expect(readFile(join(root, 'archive/state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    finally { await rm(root, { recursive: true }) }
  })
})

it('rejects a future collection window before any check executes', async () => {
  const { root, artifact } = await fixture('{_tag:\'Pass\',evidence:{}}')
  try {
    await expect(runCli(['--artifact', artifact, '--since', '2026-09-16T00:00:00Z'], { cwd: root, clock: () => new Date('2026-09-15T00:00:00Z'), stdout: () => {
      throw new Error('Unexpected output')
    } })).rejects.toThrow('Check start time is in the future.')
  }
  finally { await rm(root, { recursive: true }) }
})
