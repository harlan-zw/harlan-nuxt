import type { H3Event } from 'h3'
import type { TaskContext, TaskEvent } from 'nitropack/types'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createCloudflareBindings } from '../src/bindings'

interface TestEnvironment {
  DB: { marker: 'db' }
  OPTIONAL_CACHE?: { marker: 'cache' }
}

const bindings = createCloudflareBindings<TestEnvironment>()
const taskEnvHost = globalThis as typeof globalThis & { __env__?: unknown }

afterEach(() => {
  delete taskEnvHost.__env__
})

describe('cloudflare bindings', () => {
  it('reads a binding from a request event', () => {
    const event = { context: { cloudflare: { env: { DB: { marker: 'db' } } } } }

    expect(bindings.get('DB', event)).toEqual({ marker: 'db' })
  })

  it.each([
    ['task run input', { context: { cloudflare: { env: { DB: { marker: 'db' } } } } }],
    ['task context', { cloudflare: { env: { DB: { marker: 'db' } } } }],
  ])('reads a binding from a Nitro %s', (_label, source) => {
    expect(bindings.get('DB', source)).toEqual({ marker: 'db' })
  })

  it('falls back to the Cloudflare entry environment without an event', () => {
    taskEnvHost.__env__ = { DB: { marker: 'db' } }

    expect(bindings.get('DB')).toEqual({ marker: 'db' })
  })

  it('returns undefined for an unavailable optional binding', () => {
    const event = { context: { cloudflare: { env: { DB: { marker: 'db' } } } } }

    expect(bindings.get('OPTIONAL_CACHE', event)).toBeUndefined()
  })

  it('fails loudly for an unavailable required binding', () => {
    expect(() => bindings.require('DB', { context: {} })).toThrow('Cloudflare binding "DB" is unavailable')
  })

  it('prefers a task run input over its task context and the global fallback', () => {
    taskEnvHost.__env__ = { DB: { marker: 'global' } }
    const source = {
      cloudflare: { env: { DB: { marker: 'context' } } },
      context: { cloudflare: { env: { DB: { marker: 'input' } } } },
    }

    expect(bindings.get('DB', source)).toEqual({ marker: 'input' })
  })

  it('does not mix global bindings into an explicit environment', () => {
    taskEnvHost.__env__ = { DB: { marker: 'global' } }

    expect(bindings.get('DB', { context: { cloudflare: { env: {} } } })).toBeUndefined()
  })

  it('derives binding names and values from the generated environment type', () => {
    const event = { context: { cloudflare: { env: { DB: { marker: 'db' } } } } }

    expectTypeOf(bindings.require('DB', event)).toEqualTypeOf<{ marker: 'db' }>()
    expectTypeOf(bindings.get('OPTIONAL_CACHE')).toEqualTypeOf<{ marker: 'cache' } | undefined>()
    expectTypeOf(bindings.resolve(event)).toEqualTypeOf<TestEnvironment | undefined>()

    if (false) {
      const requestEvent = {} as H3Event
      const taskInput = {} as TaskEvent
      const taskContext = {} as TaskContext
      bindings.get('DB', requestEvent)
      bindings.get('DB', taskInput)
      bindings.get('DB', taskContext)

      // @ts-expect-error unknown binding names must be rejected by the generated environment type.
      bindings.require('TYPO')
    }
  })
})
