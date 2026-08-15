import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProjectWranglerConfig, readWranglerConfigFile } from '../src/wrangler-file'

const directories: string[] = []

afterEach(() => {
  directories.splice(0).forEach(directory => rmSync(directory, { force: true, recursive: true }))
})

describe('readWranglerConfigFile', () => {
  it.each([
    ['wrangler.jsonc', '{ // comment\n "queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" }] }\n}'],
    ['wrangler.toml', '[[queues.producers]]\nbinding = "JOBS"\nqueue = "jobs"\n'],
  ])('parses %s through one interface', (name, source) => {
    const directory = mkdtempSync(join(tmpdir(), 'nuxt-cloudflare-wrangler-'))
    directories.push(directory)
    const path = join(directory, name)
    writeFileSync(path, source)

    expect(readWranglerConfigFile(path)).toMatchObject({
      _tag: 'loaded',
      config: {
        queues: {
          producers: [{ binding: 'JOBS', queue: 'jobs' }],
        },
      },
      path,
    })
  })

  it('returns parse failures as values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nuxt-cloudflare-wrangler-'))
    directories.push(directory)
    const path = join(directory, 'wrangler.jsonc')
    writeFileSync(path, '{ "queues": {')

    expect(readWranglerConfigFile(path)).toMatchObject({
      _tag: 'invalid',
      path,
    })
  })
})

describe('findProjectWranglerConfig', () => {
  it('finds the nearest config from a nested project directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nuxt-cloudflare-wrangler-'))
    directories.push(directory)
    const nestedDirectory = join(directory, 'apps', 'site')
    const path = join(directory, 'wrangler.jsonc')
    mkdirSync(nestedDirectory, { recursive: true })
    writeFileSync(path, '{}')

    expect(findProjectWranglerConfig(nestedDirectory)).toBe(path)
  })
})
