import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/run'

async function fixture(result: string) {
  const root = await mkdtemp(join(tmpdir(), 'checkin-cli-'))
  const artifact = join(root, 'checks.mjs')
  await writeFile(artifact, `export default [{id:'one',run:(context)=>(${result})}];export const options={required:['one'],prompts:[{id:'analysis',prompt:'Review these results.'}],save:{dir:'archive',stateFile:'state.json',timestampKey:'lastRun',baseline:'daily'}}`)
  return { root, artifact }
}
describe('shared CLI', () => {
  it('archives every attempt and preserves the first complete daily baseline', async () => {
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

it.each(['Warn', 'Fail'])('advances complete daily evidence after a %s result', async (tag) => {
  const { root, artifact } = await fixture(`{_tag:'${tag}',reason:'Existing finding.',evidence:{since:context.event.since.toISOString()}}`)
  const stdout = () => {}
  try {
    expect(await runCli(['--artifact', artifact, '--save'], { cwd: root, stdout, clock: () => new Date('2026-09-14T07:00:00Z') })).toBe(1)
    expect(await runCli(['--artifact', artifact, '--save'], { cwd: root, stdout, clock: () => new Date('2026-09-15T07:00:00Z') })).toBe(1)
    const state = JSON.parse(await readFile(join(root, 'archive/state.json'), 'utf8'))
    expect(state.lastRun).toBe('2026-09-15T07:00:00.000Z')
    expect(state.coverage).toBe('complete')
    expect(state.results[0].result.evidence.since).toBe('2026-09-14T07:00:00.000Z')
    expect(state.severity).toBe(tag.toLowerCase())
    // A same-day rerun must not move the morning comparison window.
    await runCli(['--artifact', artifact, '--save'], { cwd: root, stdout, clock: () => new Date('2026-09-15T08:00:00Z') })
    expect(JSON.parse(await readFile(join(root, 'archive/state.json'), 'utf8')).lastRun).toBe(state.lastRun)
  }
  finally { await rm(root, { recursive: true }) }
})

it('preserves complete daily evidence when the next run has partial warning evidence', async () => {
  const { root, artifact } = await fixture('{_tag:\'Warn\',reason:\'Existing finding.\',evidence:{}}')
  try {
    const output = () => {}
    await runCli(['--artifact', artifact, '--save'], { cwd: root, stdout: output, clock: () => new Date('2026-09-14T07:00:00Z') })
    const incomplete = join(root, 'incomplete.mjs')
    await writeFile(incomplete, 'export default [{id:\'one\',run:()=>({_tag:\'Warn\',reason:\'Partial evidence.\',evidence:{},coverage:\'incomplete\'})}];export const options={required:[\'one\'],save:{dir:\'archive\',stateFile:\'state.json\',timestampKey:\'lastRun\',baseline:\'daily\'}}')
    expect(await runCli(['--artifact', incomplete, '--save'], { cwd: root, stdout: output, clock: () => new Date('2026-09-15T07:00:00Z') })).toBe(2)
    expect(JSON.parse(await readFile(join(root, 'archive/state.json'), 'utf8')).lastRun).toBe('2026-09-14T07:00:00.000Z')
  }
  finally { await rm(root, { recursive: true }) }
})

it('uses the shared archive directory across disposable worktrees', async () => {
  const { root, artifact } = await fixture('{_tag:\'Pass\',evidence:{since:context.event.since.toISOString()}}')
  const durable = join(root, 'durable')
  const env = { DAILY_CHECKIN_DIR: durable }
  try {
    for (const day of ['14', '15']) {
      const cwd = join(root, `worktree-${day}`)
      await mkdir(cwd)
      expect(await runCli(['--artifact', artifact, '--save'], {
        cwd,
        env,
        stdout: () => {},
        clock: () => new Date(`2026-09-${day}T07:00:00Z`),
      })).toBe(0)
      await rm(cwd, { recursive: true })
    }
    const state = JSON.parse(await readFile(join(durable, 'state.json'), 'utf8'))
    expect(state.lastRun).toBe('2026-09-15T07:00:00.000Z')
    expect(state.prompts).toEqual([{ id: 'analysis', prompt: 'Review these results.' }])
    expect(state.results[0].result.evidence.since).toBe('2026-09-14T07:00:00.000Z')
    const archives = (await readdir(durable)).filter(name => name !== 'state.json')
    expect(archives).toHaveLength(2)
    for (const name of archives)
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}\.json$/)
  }
  finally { await rm(root, { recursive: true }) }
})

it.each([
  [{}, 'archive'],
  [{ DAILY_CHECKIN_DIR: '' }, 'archive'],
  [{ DAILY_CHECKIN_DIR: 'daily', CUSTOM_ARCHIVE: 'custom' }, 'custom'],
  [{ DAILY_CHECKIN_DIR: 'daily', CUSTOM_ARCHIVE: '' }, 'archive'],
])('preserves explicit archive configuration with %j', async (env, expected) => {
  const { root, artifact } = await fixture('{_tag:\'Pass\',evidence:{}}')
  try {
    const configured = join(root, 'custom.mjs')
    const content = await readFile(artifact, 'utf8')
    await writeFile(configured, content.replace('dir:\'archive\'', 'dir:\'archive\',dirEnv:\'CUSTOM_ARCHIVE\''))
    expect(await runCli(['--artifact', configured, '--save'], { cwd: root, env, stdout: () => {} })).toBe(0)
    expect(JSON.parse(await readFile(join(root, expected, 'state.json'), 'utf8')).coverage).toBe('complete')
  }
  finally { await rm(root, { recursive: true }) }
})
