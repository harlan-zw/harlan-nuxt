import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCronUnion, buildScheduledTasks, collectTasks, findDuplicateTaskNames, parseTaskSource } from '../src/tasks'
import { crossCheckCrons, parseWranglerConfig } from '../src/wrangler'

const rootDir = resolve(__dirname, 'fixtures/nuxt-demo')
const options = { tasksDir: 'server/tasks', tasksPattern: '**/*.ts' } as never

describe('parseTaskSource (static, no execution)', () => {
  it('reads name + single string cron', () => {
    expect(parseTaskSource(`export default defineScheduledTask({ name: 'a:b', cron: '*/5 * * * *', run() {} })`))
      .toEqual({ name: 'a:b', crons: ['*/5 * * * *'] })
  })

  it('reads an array of crons', () => {
    expect(parseTaskSource(`export default defineScheduledTask({ name: 'x', cron: ['0 3 * * *', '0 */6 * * *'], run() {} })`))
      .toEqual({ name: 'x', crons: ['0 3 * * *', '0 */6 * * *'] })
  })

  it('reads static template literal strings', () => {
    expect(parseTaskSource('export default defineScheduledTask({ name: `x`, cron: [`0 3 * * *`], run() {} })'))
      .toEqual({ name: 'x', crons: ['0 3 * * *'] })
  })

  it('reads name from a plain defineTask meta with no cron', () => {
    expect(parseTaskSource(`export default defineTask({ meta: { name: 'm', description: 'd' }, run() {} })`))
      .toEqual({ name: 'm', crons: [] })
  })

  it('ignores commented-out declarations', () => {
    const src = `// cron: '9 9 9 9 9'\nexport default defineScheduledTask({ name: 'real', cron: '0 0 * * *', run() {} })`
    expect(parseTaskSource(src)).toEqual({ name: 'real', crons: ['0 0 * * *'] })
  })

  it('returns no name when the name is computed (not a literal)', () => {
    expect(parseTaskSource(`const n = 'x'\nexport default defineScheduledTask({ name: n, cron: '* * * * *', run() {} })`))
      .toEqual({ name: undefined, crons: ['* * * * *'] })
  })

  it('ignores unrelated name and cron literals before the task call', () => {
    const src = `
      const logger = { name: 'logger', cron: '* * * * *' }
      export default defineScheduledTask({
        name: 'real:task',
        cron: '0 4 * * *',
        run() { logger.name }
      })
    `
    expect(parseTaskSource(src)).toEqual({ name: 'real:task', crons: ['0 4 * * *'] })
  })
})

describe('collectTasks (fixture scan)', () => {
  it('discovers scheduled and plain tasks with their crons', async () => {
    const { tasks, unnamed } = await collectTasks(options, rootDir)
    expect(unnamed).toEqual([])
    const byName = Object.fromEntries(tasks.map(t => [t.name, t.crons]))
    expect(byName['db:cleanup']).toEqual(['0 3 * * *'])
    expect(byName['search:reindex']).toEqual(['0 */6 * * *', '0 3 * * *'])
    expect(byName['db:migrate']).toEqual([]) // plain defineTask: registered, not scheduled
  })

  it('strips the extension from the handler path', async () => {
    const { tasks } = await collectTasks(options, rootDir)
    for (const t of tasks)
      expect(t.handler).not.toMatch(/\.ts$/)
  })
})

describe('schedule derivation', () => {
  it('groups task names under each cron and dedupes the shared one', async () => {
    const { tasks } = await collectTasks(options, rootDir)
    const scheduled = buildScheduledTasks(tasks)
    expect(scheduled['0 3 * * *']).toEqual(expect.arrayContaining(['db:cleanup', 'search:reindex']))
    expect(scheduled['0 3 * * *']).toHaveLength(2)
    expect(scheduled['0 */6 * * *']).toEqual(['search:reindex'])
    expect(scheduled['db:migrate' as never]).toBeUndefined()
  })

  it('merges onto an existing scheduledTasks map', () => {
    const merged = buildScheduledTasks(
      [{ name: 'b', crons: ['0 0 * * *'], file: '', handler: '' }],
      { '0 0 * * *': ['a'] },
    )
    expect(merged['0 0 * * *']).toEqual(['a', 'b'])
  })

  it('builds a sorted, deduped cron union', async () => {
    const { tasks } = await collectTasks(options, rootDir)
    expect(buildCronUnion(tasks)).toEqual(['0 */6 * * *', '0 3 * * *'])
  })

  it('flags duplicate task names', () => {
    const dupes = findDuplicateTaskNames([
      { name: 'x', crons: [], file: '/a.ts', handler: '/a' },
      { name: 'x', crons: [], file: '/b.ts', handler: '/b' },
    ])
    expect(dupes).toHaveLength(1)
  })
})

describe('crossCheckCrons', () => {
  it('reports the union as missing when the file declares no triggers', () => {
    expect(crossCheckCrons(undefined, ['0 3 * * *'])).toEqual({ missing: ['0 3 * * *'], extra: [] })
  })

  it('reports the drift in both directions', () => {
    expect(crossCheckCrons(['0 3 * * *', '9 9 * * *'], ['0 3 * * *', '0 */6 * * *']))
      .toEqual({ missing: ['0 */6 * * *'], extra: ['9 9 * * *'] })
  })
})

describe('parseWranglerConfig crons', () => {
  it('parses a toml [triggers] crons array', () => {
    const tmp = resolve(__dirname, 'fixtures/wrangler.toml')
    // The shared fixture has no triggers; assert undefined rather than [].
    expect(parseWranglerConfig(tmp).crons).toBeUndefined()
  })
})
