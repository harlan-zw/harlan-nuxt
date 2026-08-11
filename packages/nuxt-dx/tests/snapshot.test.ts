import type { MeasuredTarget } from '../src/size-budget/rollup'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSnapshotWriter, entryKey, parseSnapshot, resolveReportPath, SNAPSHOT_FILE, SNAPSHOT_VERSION } from '../src/size-budget/snapshot'

function target(path: string, totalBytes: number, name?: string): MeasuredTarget {
  return {
    path,
    name,
    measurement: {
      key: path,
      ownBytes: 512,
      exclusiveBytes: totalBytes - 512,
      exclusiveCount: 1,
      totalBytes,
      heaviestDependencies: [],
    },
  }
}

async function writerIn(rootDir = '/app') {
  const dir = await mkdtemp(join(tmpdir(), 'nuxt-dx-'))
  const file = join(dir, 'dx', 'size-budget.json')
  const write = createSnapshotWriter(file, rootDir)
  return { write, read: async () => parseSnapshot(await readFile(file, 'utf-8'), file) }
}

describe('resolveReportPath', () => {
  it('writes nothing when the report was never asked for', () => {
    expect(resolveReportPath(undefined)).toBeUndefined()
    expect(resolveReportPath(false)).toBeUndefined()
  })

  it('takes the default path from a bare opt-in', () => {
    expect(resolveReportPath(true)).toBe(SNAPSHOT_FILE)
  })

  it('takes a path from the object form', () => {
    expect(resolveReportPath({ path: 'reports/size.json' })).toBe('reports/size.json')
  })

  it('falls back to the default path when the object names none', () => {
    expect(resolveReportPath({})).toBe(SNAPSHOT_FILE)
  })
})

describe('createSnapshotWriter', () => {
  it('writes what a build measured, keyed by identity', async () => {
    const { write, read } = await writerIn()
    await write('client', [target('/app/app/plugins/analytics.ts', 20_480)])
    expect((await read()).entries).toEqual([{
      scope: 'client',
      path: 'app/plugins/analytics.ts',
      ownBytes: 512,
      exclusiveBytes: 19_968,
      totalBytes: 20_480,
    }])
  })

  it('keeps a name when the target has one', async () => {
    const { write, read } = await writerIn()
    await write('modules', [target('/app/node_modules/@nuxtjs/i18n', 1024, '@nuxtjs/i18n')])
    expect((await read()).entries[0]).toMatchObject({ name: '@nuxtjs/i18n', path: '@nuxtjs/i18n' })
  })

  it('collects every scope into one report as each bundle finishes', async () => {
    const { write, read } = await writerIn()
    await write('client', [target('/app/app/plugins/a.ts', 1024)])
    await write('nitro', [target('/app/server/plugins/b.ts', 2048)])
    expect((await read()).entries.map(entryKey)).toEqual(['client:app/plugins/a.ts', 'nitro:server/plugins/b.ts'])
  })

  it('replaces a scope rather than appending to it, so a rebuild never doubles up', async () => {
    const { write, read } = await writerIn()
    await write('client', [target('/app/app/plugins/a.ts', 1024)])
    await write('client', [target('/app/app/plugins/a.ts', 4096)])
    const { entries } = await read()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.totalBytes).toBe(4096)
  })
})

describe('parseSnapshot', () => {
  const valid = JSON.stringify({
    version: SNAPSHOT_VERSION,
    entries: [{ scope: 'client', path: 'a.ts', ownBytes: 1, exclusiveBytes: 2, totalBytes: 3 }],
  })

  it('accepts a report this CLI wrote', () => {
    expect(parseSnapshot(valid, 'base.json').entries).toHaveLength(1)
  })

  it('names the file it could not read', () => {
    expect(() => parseSnapshot('{', 'base.json')).toThrow('base.json is not valid JSON')
  })

  it('refuses a report from a different format version', () => {
    const future = JSON.stringify({ version: SNAPSHOT_VERSION + 1, entries: [] })
    expect(() => parseSnapshot(future, 'head.json')).toThrow(/format/)
  })

  it('refuses entries it cannot measure', () => {
    const broken = JSON.stringify({ version: SNAPSHOT_VERSION, entries: [{ scope: 'client', path: 'a.ts' }] })
    expect(() => parseSnapshot(broken, 'head.json')).toThrow(/cannot read/)
  })

  it('refuses a scope it does not know', () => {
    const broken = JSON.stringify({ version: SNAPSHOT_VERSION, entries: [{ scope: 'worker', path: 'a.ts', ownBytes: 1, exclusiveBytes: 1, totalBytes: 2 }] })
    expect(() => parseSnapshot(broken, 'head.json')).toThrow(/cannot read/)
  })
})
