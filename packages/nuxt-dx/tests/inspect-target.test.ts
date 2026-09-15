import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverDevServer, parseDevServer, recordDevServer, resolveInspectionTarget } from '../src/dev-server'

describe('inspection target', () => {
  it('uses the running server and app base for home', () => {
    expect(resolveInspectionTarget('/', 'http://localhost:4317/app/')).toBe('http://localhost:4317/app/')
    expect(resolveInspectionTarget('/about?q=1', 'http://localhost:4317/app/')).toBe('http://localhost:4317/app/about?q=1')
  })

  it('accepts a full URL without a local server', () => {
    expect(resolveInspectionTarget('https://example.com/about')).toBe('https://example.com/about')
  })

  it.each(['//example.com', 'file:///etc/passwd', 'javascript:alert(1)', '/\\example.com'])('rejects unsafe targets: %s', (target) => {
    expect(() => resolveInspectionTarget(target, 'http://localhost:3000/')).toThrow()
  })

  it('explains how to start a server when discovery is unavailable', () => {
    expect(() => resolveInspectionTarget('/about')).toThrow('Start Nuxt dev')
  })

  it('parses server metadata and rejects invalid process IDs and URLs', () => {
    expect(parseDevServer({ pid: 123, url: 'http://localhost:4317/app/' })).toEqual({ pid: 123, url: 'http://localhost:4317/app/' })
    for (const value of [null, {}, { pid: -1, url: 'http://localhost/' }, { pid: 1, url: 'file:///tmp' }])
      expect(() => parseDevServer(value)).toThrow('server metadata')
  })

  it('discovers the bound URL and keeps a newer listener during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-dx-inspect-'))
    try {
      expect(await discoverDevServer(root)).toBeUndefined()
      const closeFirst = await recordDevServer(root, 'http://0.0.0.0:4317', '/app/')
      expect(await discoverDevServer(root)).toBe('http://localhost:4317/app/')
      const closeSecond = await recordDevServer(root, 'http://[::]:4318', '/')
      await closeFirst()
      expect(await discoverDevServer(root)).toBe('http://localhost:4318/')
      await closeSecond()
      expect(await discoverDevServer(root)).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
