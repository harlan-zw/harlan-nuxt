import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveContractQueryEnforcementOptions } from '../src/enforcement/options'
import { readSourceFilesFromDisk } from '../src/enforcement/read'

const io = vi.hoisted(() => ({
  activeReads: 0,
  maxActiveReads: 0,
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: {
      ...actual,
      readFile: io.readFile,
      readdir: io.readdir,
      stat: io.stat,
    },
    readFile: io.readFile,
    readdir: io.readdir,
    stat: io.stat,
  }
})

describe('contract source reader performance', () => {
  beforeEach(() => {
    io.activeReads = 0
    io.maxActiveReads = 0
    io.readFile.mockReset().mockImplementation(async (path: string) => {
      io.activeReads++
      io.maxActiveReads = Math.max(io.maxActiveReads, io.activeReads)
      await new Promise(resolve => setTimeout(resolve, 5))
      io.activeReads--
      return `export const source = ${JSON.stringify(path)}`
    })
    io.readdir.mockReset().mockImplementation(async (path: string) => {
      if (!path.endsWith('/app'))
        throw new Error(`Unexpected directory: ${path}`)
      return Array.from({ length: 64 }, (_, index) => ({
        isDirectory: () => false,
        name: `source-${index}.ts`,
      }))
    })
    io.stat.mockReset()
  })

  it('reads discovered source files concurrently', async () => {
    const options = resolveContractQueryEnforcementOptions({ scanDirs: ['app'] })
    const files = await readSourceFilesFromDisk('/project', options)

    expect(files).toHaveLength(64)
    expect(io.maxActiveReads).toBeGreaterThan(1)
    expect(io.maxActiveReads).toBeLessThanOrEqual(32)
  })
})
