import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { readCheckId } from '../src/build/discovery'

describe('check discovery', () => {
  it('reads the exported factory without evaluating server dependencies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkin-'))
    try {
      const file = join(dir, 'check.ts')
      await writeFile(file, `throw new Error('Must not execute'); export default defineQueueCheck({ id: 'queue.indexing' })`)
      expect(await readCheckId(file)).toBe('queue.indexing')
      await writeFile(file, `const id = 'computed'; export default defineCheck({ id })`)
      await expect(readCheckId(file)).rejects.toThrow('literal ID')
    }
    finally { await rm(dir, { recursive: true }) }
  })
})
