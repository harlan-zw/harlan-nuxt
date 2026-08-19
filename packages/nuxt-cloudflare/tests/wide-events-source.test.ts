import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateWideEventSource } from '@harlan-zw/nuxt-wide-events/build'
import { describe, expect, it } from 'vitest'

// `@harlan-zw/nuxt-wide-events` parses server sources at build time and rejects
// an `addWideEventFields` call that is not a plain object literal. That check
// runs in the CONSUMING application's build, so a violation here does not fail
// this package — it fails somebody else's deploy, which is exactly what 0.0.15
// and 0.0.16 did.
//
// Running that same validator over our own plugin is the only way this repo can
// see what a consumer sees.
const PLUGIN = fileURLToPath(new URL('../src/runtime/server/plugins/wide-events.ts', import.meta.url))

const DECLARED_FIELDS = new Set([
  'cf.colo',
  'cf.country',
  'cf.httpProtocol',
  'd1.durationMs',
  'd1.primaryQueries',
  'd1.queries',
  'd1.recoveries',
  'd1.region',
  'd1.unrecovered',
])

describe('wide events plugin source', () => {
  it('passes the validator that runs in a consuming application build', () => {
    const source = readFileSync(PLUGIN, 'utf8')

    expect(validateWideEventSource(source, PLUGIN, DECLARED_FIELDS)).toEqual({ _tag: 'Ok' })
  })

  it('rejects the dynamic-object shape that broke a consumer', () => {
    // Pinning the failure mode, not just the fix: assembling a Record and
    // passing the variable is the natural way to write this and the one the
    // validator forbids.
    const dynamic = `
      import { addWideEventFields } from '#imports'
      export function record(event) {
        const fields = {}
        fields['cf.colo'] = 'SYD'
        addWideEventFields(event, fields)
      }
    `
    expect(validateWideEventSource(dynamic, 'dynamic.ts', DECLARED_FIELDS)._tag).toBe('Err')
  })

  it('declares every field the plugin writes', () => {
    // A field the plugin writes but the module never declares fails the
    // consumer's build the same way; keep the two lists in step.
    const source = readFileSync(PLUGIN, 'utf8')
    const written = [...source.matchAll(/'((?:cf|d1)\.[A-Za-z]+)':/g)].map(m => m[1]!)

    expect(written.length).toBeGreaterThan(0)
    for (const field of written)
      expect(DECLARED_FIELDS).toContain(field)
  })
})
