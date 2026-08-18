import { readFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { readCliVersion } from '../src/cli/meta'

describe('readCliVersion', () => {
  it('reports the version this package publishes', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { version: string }

    expect(readCliVersion()).toBe(packageJson.version)
  })
})
