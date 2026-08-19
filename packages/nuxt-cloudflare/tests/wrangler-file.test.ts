import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProjectWranglerConfig, readAuthoredWranglerConfig, readWranglerConfigFile } from '../src/wrangler-file'

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

describe('readAuthoredWranglerConfig', () => {
  it('reads the root config Wrangler and Nitro both treat as the source of truth', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nuxt-cloudflare-wrangler-'))
    directories.push(directory)
    const path = join(directory, 'wrangler.jsonc')
    writeFileSync(path, '{ "observability": { "logs": { "head_sampling_rate": 1 } } }')

    expect(readAuthoredWranglerConfig(directory)).toEqual({
      _tag: 'authored',
      config: { observability: { logs: { head_sampling_rate: 1 } } },
      path,
    })
  })

  it('reports an absent root config without a project directory', () => {
    expect(readAuthoredWranglerConfig(undefined)).toEqual({ _tag: 'absent' })
  })

  it('returns an unparsable root config as a value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nuxt-cloudflare-wrangler-'))
    directories.push(directory)
    writeFileSync(join(directory, 'wrangler.jsonc'), '{ "observability": {')

    expect(readAuthoredWranglerConfig(directory)).toMatchObject({
      _tag: 'invalid',
      path: join(directory, 'wrangler.jsonc'),
    })
  })
})
